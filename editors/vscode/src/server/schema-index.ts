/**
 * Lightweight, position-aware index of an `.ember` document. The AST parser
 * discards source spans, so the language server scans the text directly to map
 * model/enum/field names to ranges — enough for navigation, references,
 * rename, completion and symbols.
 */

export interface Loc {
  line: number;
  character: number;
}
export interface Span {
  start: Loc;
  end: Loc;
}

export type BlockKind = "model" | "enum" | "datasource" | "generator" | "type";

export interface FieldEntry {
  name: string;
  nameSpan: Span;
  /** The declared type (scalar, enum or model name); empty for enum values. */
  type: string;
  typeSpan: Span | null;
  line: number;
}

export interface BlockEntry {
  kind: BlockKind;
  name: string;
  nameSpan: Span;
  bodyStartLine: number;
  bodyEndLine: number;
  fields: FieldEntry[];
}

export interface SchemaIndex {
  blocks: BlockEntry[];
  models: BlockEntry[];
  enums: BlockEntry[];
  modelAndEnumNames: Set<string>;
}

const BLOCK_RE = /^(\s*)(model|enum|datasource|generator|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const FIELD_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s+)([A-Za-z_][A-Za-z0-9_]*)/;
const ENUM_VALUE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)/;

export function buildIndex(text: string): SchemaIndex {
  const lines = text.split(/\r?\n/);
  const blocks: BlockEntry[] = [];
  let current: BlockEntry | null = null;

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!;
    const code = stripComment(raw);

    if (!current) {
      const m = BLOCK_RE.exec(code);
      if (m) {
        const indent = m[1]!.length;
        const kw = m[2] as BlockKind;
        const name = m[3]!;
        const nameStart = indent + m[2]!.length + (m[0]!.length - indent - m[2]!.length - name.length);
        const start = code.indexOf(name, indent + kw.length);
        current = {
          kind: kw,
          name,
          nameSpan: span(line, start, name.length),
          bodyStartLine: line,
          bodyEndLine: line,
          fields: [],
        };
        void nameStart;
      }
      continue;
    }

    if (/^\s*}/.test(code)) {
      current.bodyEndLine = line;
      blocks.push(current);
      current = null;
      continue;
    }

    if (current.kind === "model" || current.kind === "type") {
      const fm = FIELD_RE.exec(code);
      if (fm && !code.trim().startsWith("@@")) {
        const name = fm[2]!;
        const type = fm[4]!.replace(/[?\[\]]/g, "");
        const nameChar = fm[1]!.length;
        const typeChar = nameChar + name.length + fm[3]!.length;
        current.fields.push({
          name,
          nameSpan: span(line, nameChar, name.length),
          type,
          typeSpan: span(line, typeChar, fm[4]!.length),
          line,
        });
      }
    } else if (current.kind === "enum") {
      const em = ENUM_VALUE_RE.exec(code);
      if (em && !code.trim().startsWith("@@")) {
        const name = em[2]!;
        current.fields.push({
          name,
          nameSpan: span(line, em[1]!.length, name.length),
          type: "",
          typeSpan: null,
          line,
        });
      }
    }
  }

  const models = blocks.filter((b) => b.kind === "model" || b.kind === "type");
  const enums = blocks.filter((b) => b.kind === "enum");
  return {
    blocks,
    models,
    enums,
    modelAndEnumNames: new Set([...models, ...enums].map((b) => b.name)),
  };
}

/** The block/enum named `name`, if declared. */
export function findBlock(index: SchemaIndex, name: string): BlockEntry | undefined {
  return index.blocks.find((b) => b.name === name);
}

/** The block whose body contains `line`. */
export function blockAt(index: SchemaIndex, line: number): BlockEntry | undefined {
  return index.blocks.find(
    (b) => line >= b.bodyStartLine && line <= b.bodyEndLine,
  );
}

/** The identifier token under `pos`, with its span, if any. */
export function wordAt(text: string, pos: Loc): { word: string; span: Span } | null {
  const line = text.split(/\r?\n/)[pos.line];
  if (line === undefined) return null;
  let start = pos.character;
  let end = pos.character;
  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (start > 0 && isWord(line[start - 1]!)) start--;
  while (end < line.length && isWord(line[end]!)) end++;
  if (start === end) return null;
  return { word: line.slice(start, end), span: span(pos.line, start, end - start) };
}

function span(line: number, character: number, length: number): Span {
  return {
    start: { line, character },
    end: { line, character: character + length },
  };
}

function stripComment(line: string): string {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}
