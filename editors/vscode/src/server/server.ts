import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  CompletionItemKind,
  SymbolKind,
  CodeActionKind,
  TextEdit,
  type Diagnostic,
  type InitializeResult,
  type CompletionItem,
  type Hover,
  type Location,
  type WorkspaceEdit,
  type DocumentSymbol,
  type CodeAction,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  parseAndValidate,
  formatSchema,
  SchemaParseError,
  SchemaValidationError,
  SCALAR_TYPES,
} from "ember-orm/editor";
import {
  buildIndex,
  blockAt,
  findBlock,
  wordAt,
  type SchemaIndex,
  type Span,
} from "./schema-index";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ["@", ".", " "] },
    hoverProvider: true,
    documentFormattingProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    documentSymbolProvider: true,
    codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll] },
  },
}));

// ---- diagnostics ----------------------------------------------------------

documents.onDidChangeContent((change) => validate(change.document));

function validate(doc: TextDocument): void {
  const text = doc.getText();
  const diagnostics: Diagnostic[] = [];
  try {
    parseAndValidate(text);
  } catch (err) {
    if (err instanceof SchemaParseError) {
      const line = Math.max(0, err.line - 1);
      const ch = Math.max(0, err.column - 1);
      diagnostics.push(diag(text, line, ch, err.message));
    } else if (err instanceof SchemaValidationError) {
      const details = err.details.length ? err.details : [err.message];
      for (const d of details) diagnostics.push(locate(text, d));
    } else {
      diagnostics.push(diag(text, 0, 0, String((err as Error).message ?? err)));
    }
  }
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

function diag(text: string, line: number, ch: number, message: string): Diagnostic {
  const w = wordAt(text, { line, character: ch });
  const range = w ? w.span : { start: { line, character: ch }, end: { line, character: ch + 1 } };
  return { range, message, severity: DiagnosticSeverity.Error, source: "ember" };
}

function locate(text: string, detail: string): Diagnostic {
  const quoted = /'([^']+)'/.exec(detail);
  if (quoted) {
    const name = quoted[1]!.split(".").pop()!;
    const idx = text.indexOf(name);
    if (idx >= 0) {
      const pos = offsetToPos(text, idx);
      return {
        range: { start: pos, end: { line: pos.line, character: pos.character + name.length } },
        message: detail,
        severity: DiagnosticSeverity.Error,
        source: "ember",
      };
    }
  }
  return diag(text, 0, 0, detail);
}

// ---- formatting -----------------------------------------------------------

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  try {
    const formatted = formatSchema(doc.getText());
    if (formatted === doc.getText()) return [];
    return [TextEdit.replace(fullRange(doc), formatted)];
  } catch {
    return [];
  }
});

// ---- completion -----------------------------------------------------------

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const line = lineText(text, params.position.line);
  const prefix = line.slice(0, params.position.character);
  const index = buildIndex(text);

  if (/@@\w*$/.test(prefix)) return BLOCK_ATTRIBUTES.map(attrItem);
  if (/(^|[^@])@\w*$/.test(prefix)) return FIELD_ATTRIBUTES.map(attrItem);
  if (/@db\.\w*$/.test(prefix)) return NATIVE_TYPES.map((t) => item(t, CompletionItemKind.TypeParameter));

  const block = blockAt(index, params.position.line);
  // Type position: `fieldName <here>` inside a model body.
  if (block && (block.kind === "model" || block.kind === "type") && /^\s*[A-Za-z_]\w*\s+[A-Za-z_]?\w*$/.test(prefix)) {
    const types = [
      ...SCALAR_TYPES.map((t) => item(t, CompletionItemKind.Class)),
      ...index.models.filter((m) => m.kind !== "type").map((m) => item(m.name, CompletionItemKind.Reference, "model")),
      ...index.enums.map((e) => item(e.name, CompletionItemKind.Enum, "enum")),
    ];
    return types;
  }

  // Default / top-level: block keywords + default functions.
  return [
    ...BLOCK_KEYWORDS.map((k) => item(k, CompletionItemKind.Keyword)),
    ...DEFAULT_FUNCTIONS.map((f) => snippetItem(f, `${f}($0)`, `Default function ${f}()`)),
  ];
});

// ---- hover ----------------------------------------------------------------

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const w = wordAt(text, params.position);
  if (!w) return null;
  const index = buildIndex(text);

  const block = findBlock(index, w.word);
  if (block) {
    const kind = block.kind === "enum" ? "enum" : "model";
    return md(`**${kind} ${block.name}** — ${block.fields.length} field(s)`, w.span);
  }
  if (HOVERS[w.word]) return md(HOVERS[w.word]!, w.span);
  return null;
});

// ---- go to definition -----------------------------------------------------

connection.onDefinition((params): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const w = wordAt(text, params.position);
  if (!w) return null;
  const target = findBlock(buildIndex(text), w.word);
  if (!target) return null;
  return { uri: doc.uri, range: target.nameSpan };
});

// ---- references -----------------------------------------------------------

connection.onReferences((params): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const w = wordAt(text, params.position);
  if (!w) return [];
  return findOccurrences(text, w.word).map((span) => ({ uri: doc.uri, range: span }));
});

// ---- rename ---------------------------------------------------------------

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const w = wordAt(text, params.position);
  if (!w) return null;
  const index = buildIndex(text);
  // Allow renaming a model/enum name or a field name.
  if (index.modelAndEnumNames.has(w.word) || isFieldName(index, w.word, params.position.line)) {
    return w.span;
  }
  return null;
});

connection.onRenameRequest((params): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const w = wordAt(text, params.position);
  if (!w) return null;
  const edits = findOccurrences(text, w.word).map((span) =>
    TextEdit.replace(span, params.newName),
  );
  if (edits.length === 0) return null;
  return { changes: { [doc.uri]: edits } };
});

// ---- document symbols (outline) -------------------------------------------

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const index = buildIndex(doc.getText());
  return index.blocks.map((b) => ({
    name: b.name,
    kind:
      b.kind === "enum"
        ? SymbolKind.Enum
        : b.kind === "model" || b.kind === "type"
          ? SymbolKind.Class
          : SymbolKind.Namespace,
    range: { start: { line: b.bodyStartLine, character: 0 }, end: { line: b.bodyEndLine, character: 1 } },
    selectionRange: b.nameSpan,
    children: b.fields.map((f) => ({
      name: f.name,
      detail: f.type,
      kind: b.kind === "enum" ? SymbolKind.EnumMember : SymbolKind.Field,
      range: f.nameSpan,
      selectionRange: f.nameSpan,
    })),
  }));
});

// ---- code actions ---------------------------------------------------------

connection.onCodeAction((params): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  let formatted: string;
  try {
    formatted = formatSchema(doc.getText());
  } catch {
    return [];
  }
  if (formatted === doc.getText()) return [];
  const edit: WorkspaceEdit = {
    changes: { [doc.uri]: [TextEdit.replace(fullRange(doc), formatted)] },
  };
  return [
    {
      title: "Ember: complete relations & format",
      kind: CodeActionKind.SourceFixAll,
      edit,
    },
  ];
});

// ---- helpers --------------------------------------------------------------

function findOccurrences(text: string, word: string): Span[] {
  const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");
  const spans: Span[] = [];
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const code = lines[line]!.replace(/\/\/.*$/, "");
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      spans.push({
        start: { line, character: m.index },
        end: { line, character: m.index + word.length },
      });
    }
  }
  return spans;
}

function isFieldName(index: SchemaIndex, word: string, line: number): boolean {
  const block = blockAt(index, line);
  return !!block?.fields.some((f) => f.name === word && f.line === line);
}

function fullRange(doc: TextDocument) {
  return { start: { line: 0, character: 0 }, end: doc.positionAt(doc.getText().length) };
}

function lineText(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? "";
}

function offsetToPos(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  const character = offset - (before.lastIndexOf("\n") + 1);
  return { line, character };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function item(label: string, kind: CompletionItemKind, detail?: string): CompletionItem {
  return { label, kind, detail };
}
function snippetItem(label: string, insert: string, doc: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Function,
    insertText: insert,
    insertTextFormat: 2,
    documentation: doc,
  };
}
function attrItem(a: { label: string; insert: string; doc: string }): CompletionItem {
  return {
    label: a.label,
    kind: CompletionItemKind.Keyword,
    insertText: a.insert,
    insertTextFormat: 2,
    documentation: a.doc,
  };
}
function md(value: string, range: Span): Hover {
  return { contents: { kind: "markdown", value }, range };
}

const BLOCK_KEYWORDS = ["model", "enum", "datasource", "generator", "type"];
const DEFAULT_FUNCTIONS = ["autoincrement", "now", "uuid", "cuid", "env"];
const NATIVE_TYPES = [
  "VarChar", "Char", "Text", "SmallInt", "Integer", "BigInt", "Float",
  "DoublePrecision", "Decimal", "Boolean", "Date", "Time", "Timestamp", "Blob",
];
const FIELD_ATTRIBUTES = [
  { label: "@id", insert: "id", doc: "Primary key." },
  { label: "@unique", insert: "unique", doc: "Unique constraint." },
  { label: "@default", insert: "default($0)", doc: "Default value: now(), autoincrement(), literal, enum value." },
  { label: "@relation", insert: "relation(fields: [$1], references: [$2])", doc: "Relation + foreign key." },
  { label: "@map", insert: 'map("$0")', doc: "Database column name." },
  { label: "@updatedAt", insert: "updatedAt", doc: "Set to now on every update." },
  { label: "@db", insert: "db.$0", doc: "Native Firebird type." },
];
const BLOCK_ATTRIBUTES = [
  { label: "@@id", insert: "id([$0])", doc: "Composite primary key." },
  { label: "@@unique", insert: "unique([$0])", doc: "Composite unique constraint." },
  { label: "@@index", insert: "index([$0])", doc: "Index." },
  { label: "@@map", insert: 'map("$0")', doc: "Database table name." },
];
const HOVERS: Record<string, string> = {
  model: "**model** — a table-backed entity.",
  enum: "**enum** — an enumeration.",
  datasource: "**datasource** — Firebird connection (provider + url).",
  generator: "**generator** — client code generation config.",
  String: "`String` — VARCHAR/CHAR/text BLOB.",
  Boolean: "`Boolean` — BOOLEAN (FB3+) / SMALLINT (FB2.x).",
  Int: "`Int` — INTEGER.",
  BigInt: "`BigInt` — BIGINT.",
  Float: "`Float` — DOUBLE PRECISION.",
  Decimal: "`Decimal` — DECIMAL(p, s).",
  DateTime: "`DateTime` — TIMESTAMP/DATE/TIME.",
  Json: "`Json` — JSON stored as text.",
  Bytes: "`Bytes` — BLOB SUB_TYPE BINARY.",
};

documents.listen(connection);
connection.listen();
