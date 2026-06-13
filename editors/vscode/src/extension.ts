import * as vscode from "vscode";
import {
  parseAndValidate,
  formatSchema,
  SchemaParseError,
  SchemaValidationError,
  SCALAR_TYPES,
} from "ember-orm/editor";

const LANGUAGE = "ember";

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("ember");
  context.subscriptions.push(diagnostics);

  const validate = (doc: vscode.TextDocument) => {
    if (doc.languageId !== LANGUAGE) return;
    diagnostics.set(doc.uri, computeDiagnostics(doc));
  };

  // Validate on open / change / save (change gated by the validateOnType setting).
  for (const doc of vscode.workspace.textDocuments) validate(doc);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidSaveTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const onType = vscode.workspace
        .getConfiguration("ember")
        .get<boolean>("validateOnType", true);
      if (onType) validate(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
  );

  // Formatting: auto-complete missing relation sides, fix indentation, and
  // re-print the canonical schema (identical to `ember format`). Combined with
  // editor.formatOnSave this fixes indentation and adds the parent-side relation
  // automatically on save, just like Prisma.
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE, {
      provideDocumentFormattingEdits(doc) {
        try {
          const formatted = formatSchema(doc.getText());
          if (formatted === doc.getText()) return [];
          return [vscode.TextEdit.replace(fullRange(doc), formatted)];
        } catch {
          // Surface the error via diagnostics; do not reformat invalid input.
          return [];
        }
      },
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      LANGUAGE,
      completionProvider(),
      "@",
      ".",
    ),
    vscode.languages.registerHoverProvider(LANGUAGE, hoverProvider()),
  );

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("ember.format", () =>
      vscode.commands.executeCommand("editor.action.formatDocument"),
    ),
    vscode.commands.registerCommand("ember.generate", () => runCli("generate")),
    vscode.commands.registerCommand("ember.dbPull", () => runCli("db pull")),
    vscode.commands.registerCommand("ember.validate", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) validate(editor.document);
      vscode.window.showInformationMessage("Ember: schema validated.");
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ---- diagnostics ----------------------------------------------------------

function computeDiagnostics(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const text = doc.getText();
  try {
    parseAndValidate(text);
    return [];
  } catch (err) {
    if (err instanceof SchemaParseError) {
      const line = Math.max(0, err.line - 1);
      const col = Math.max(0, err.column - 1);
      const range = wordRangeAt(doc, line, col);
      return [diag(range, err.message, vscode.DiagnosticSeverity.Error)];
    }
    if (err instanceof SchemaValidationError) {
      return err.details.length
        ? err.details.map((d) => diag(locate(doc, d), d, vscode.DiagnosticSeverity.Error))
        : [diag(firstLine(doc), err.message, vscode.DiagnosticSeverity.Error)];
    }
    return [diag(firstLine(doc), String((err as Error).message ?? err), vscode.DiagnosticSeverity.Error)];
  }
}

function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "ember";
  return d;
}

/** Try to place a validation message at a quoted name it references. */
function locate(doc: vscode.TextDocument, detail: string): vscode.Range {
  const quoted = /'([^']+)'/.exec(detail);
  if (quoted) {
    const name = quoted[1]!.split(".").pop()!;
    const idx = doc.getText().indexOf(name);
    if (idx >= 0) {
      const pos = doc.positionAt(idx);
      return new vscode.Range(pos, pos.translate(0, name.length));
    }
  }
  return firstLine(doc);
}

function wordRangeAt(doc: vscode.TextDocument, line: number, col: number): vscode.Range {
  const safeLine = Math.min(line, Math.max(0, doc.lineCount - 1));
  const pos = new vscode.Position(safeLine, col);
  return doc.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos.translate(0, 1));
}

function firstLine(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(0, 0, 0, Math.max(1, doc.lineAt(0).text.length));
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  const last = doc.lineCount - 1;
  return new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
}

// ---- completion -----------------------------------------------------------

function completionProvider(): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const linePrefix = document
        .lineAt(position)
        .text.slice(0, position.character);
      const items: vscode.CompletionItem[] = [];

      // After `@@` -> block attributes; after `@` -> field attributes.
      if (/@@\w*$/.test(linePrefix)) {
        for (const a of BLOCK_ATTRIBUTES) items.push(snippet(a.label, a.insert, a.doc, vscode.CompletionItemKind.Keyword));
        return items;
      }
      if (/[^@]@\w*$/.test(linePrefix) || /^@\w*$/.test(linePrefix)) {
        for (const a of FIELD_ATTRIBUTES) items.push(snippet(a.label, a.insert, a.doc, vscode.CompletionItemKind.Keyword));
        return items;
      }
      if (/@db\.\w*$/.test(linePrefix)) {
        for (const t of NATIVE_TYPES) items.push(plain(t, vscode.CompletionItemKind.TypeParameter));
        return items;
      }

      for (const kw of BLOCK_KEYWORDS) items.push(plain(kw, vscode.CompletionItemKind.Keyword));
      for (const t of SCALAR_TYPES) items.push(plain(t, vscode.CompletionItemKind.Class));
      for (const fn of DEFAULT_FUNCTIONS) {
        items.push(snippet(fn, `${fn}($0)`, `Default function ${fn}()`, vscode.CompletionItemKind.Function));
      }
      return items;
    },
  };
}

function plain(label: string, kind: vscode.CompletionItemKind): vscode.CompletionItem {
  return new vscode.CompletionItem(label, kind);
}

function snippet(
  label: string,
  insert: string,
  doc: string,
  kind: vscode.CompletionItemKind,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, kind);
  item.insertText = new vscode.SnippetString(insert);
  item.documentation = new vscode.MarkdownString(doc);
  return item;
}

// ---- hover ----------------------------------------------------------------

function hoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position);
      if (!range) return undefined;
      const word = document.getText(range);
      const doc = HOVERS[word];
      return doc ? new vscode.Hover(new vscode.MarkdownString(doc), range) : undefined;
    },
  };
}

// ---- CLI ------------------------------------------------------------------

function runCli(command: string): void {
  const cliPath = vscode.workspace
    .getConfiguration("ember")
    .get<string>("cliPath", "npx ember");
  const terminal =
    vscode.window.terminals.find((t) => t.name === "Ember") ??
    vscode.window.createTerminal("Ember");
  terminal.show();
  terminal.sendText(`${cliPath} ${command}`);
}

// ---- static metadata ------------------------------------------------------

const BLOCK_KEYWORDS = ["model", "enum", "datasource", "generator", "type"];
const NATIVE_TYPES = [
  "VarChar",
  "Char",
  "Text",
  "SmallInt",
  "Integer",
  "BigInt",
  "Float",
  "DoublePrecision",
  "Decimal",
  "Boolean",
  "Date",
  "Time",
  "Timestamp",
  "Blob",
];
const DEFAULT_FUNCTIONS = ["autoincrement", "now", "uuid", "cuid", "env"];

const FIELD_ATTRIBUTES = [
  { label: "@id", insert: "id", doc: "Marks the field as the primary key." },
  { label: "@unique", insert: "unique", doc: "Adds a unique constraint." },
  { label: "@default", insert: "default($0)", doc: "Sets a default value, e.g. `now()`, `autoincrement()`, a literal." },
  { label: "@relation", insert: "relation(fields: [$1], references: [$2])", doc: "Defines a relation and its foreign key." },
  { label: "@map", insert: 'map("$0")', doc: "Maps the field to a database column name." },
  { label: "@updatedAt", insert: "updatedAt", doc: "Automatically set to now on every update." },
  { label: "@db", insert: "db.$0", doc: "Native Firebird column type, e.g. `@db.VarChar(255)`." },
];

const BLOCK_ATTRIBUTES = [
  { label: "@@id", insert: "id([$0])", doc: "Composite primary key." },
  { label: "@@unique", insert: "unique([$0])", doc: "Composite unique constraint." },
  { label: "@@index", insert: "index([$0])", doc: "Index." },
  { label: "@@map", insert: 'map("$0")', doc: "Maps the model to a database table name." },
];

const HOVERS: Record<string, string> = {
  model: "**model** — defines a table-backed entity.",
  enum: "**enum** — defines an enumeration.",
  datasource: "**datasource** — the Firebird connection (provider + url).",
  generator: "**generator** — configures client code generation.",
  String: "`String` — text. Firebird `VARCHAR`/`CHAR`/text `BLOB`.",
  Boolean: "`Boolean` — true/false. Firebird `BOOLEAN` (3+) or `SMALLINT` (2.x).",
  Int: "`Int` — 32-bit integer (`INTEGER`).",
  BigInt: "`BigInt` — 64-bit integer (`BIGINT`).",
  Float: "`Float` — floating point (`DOUBLE PRECISION`).",
  Decimal: "`Decimal` — fixed precision (`DECIMAL(p, s)`).",
  DateTime: "`DateTime` — date/time (`TIMESTAMP`/`DATE`/`TIME`).",
  Json: "`Json` — JSON stored as text. Filter with `string_contains` etc.",
  Bytes: "`Bytes` — binary (`BLOB SUB_TYPE BINARY`).",
};
