import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SchemaDocument } from "@ember/ast";
import { Parser } from "./parser";
import { validateSchema } from "./validator";
import { printSchema } from "./printer";

export { Parser } from "./parser";
export { Lexer } from "./lexer";
export { validateSchema } from "./validator";
export { printSchema } from "./printer";

/** Parse schema source text into an AST (no validation). */
export function parseSchema(source: string, file?: string): SchemaDocument {
  return new Parser(source, file).parse();
}

/** Parse and validate schema source text. */
export function parseAndValidate(source: string, file?: string): SchemaDocument {
  const doc = parseSchema(source, file);
  validateSchema(doc);
  return doc;
}

export interface LoadedSchema {
  document: SchemaDocument;
  path: string;
  /** Resolved connection URL (env() expanded). */
  databaseUrl?: string;
}

const DEFAULT_SCHEMA_PATHS = [
  "ember/schema.ember",
  "schema.ember",
  "prisma/schema.ember",
];

/** Locate the schema file relative to a base directory. */
export function findSchemaPath(
  base = process.cwd(),
  explicit?: string,
): string | undefined {
  if (explicit) {
    const p = resolve(base, explicit);
    return existsSync(p) ? p : undefined;
  }
  for (const candidate of DEFAULT_SCHEMA_PATHS) {
    const p = resolve(base, candidate);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Load, parse, validate a schema file and resolve its datasource URL. */
export function loadSchema(path: string): LoadedSchema {
  const source = readFileSync(path, "utf8");
  const document = parseAndValidate(source, path);
  return {
    document,
    path,
    databaseUrl: resolveDatasourceUrl(document, dirname(path)),
  };
}

export function resolveDatasourceUrl(
  doc: SchemaDocument,
  _base: string,
): string | undefined {
  const ds = doc.datasource;
  if (!ds) return undefined;
  if (ds.url.kind === "literal") return ds.url.value;
  return process.env[ds.url.value];
}
