/**
 * EmberORM schema AST (DMMF-like).
 *
 * This is the single in-memory source of truth that every other layer
 * (parser, validator, query engine, generator, introspection) depends on.
 * It is intentionally decoupled from Firebird specifics so it can be reused
 * for other dialects in the future.
 */

export type ScalarType =
  | "String"
  | "Boolean"
  | "Int"
  | "BigInt"
  | "Float"
  | "Decimal"
  | "DateTime"
  | "Bytes"
  | "Json";

export const SCALAR_TYPES: readonly ScalarType[] = [
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Bytes",
  "Json",
] as const;

export type FieldKind = "scalar" | "enum" | "object";

/** Value of an attribute argument, e.g. `@default(now())` or `@map("USER_ID")`. */
export type AttributeArgValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "ref"; value: string } // bare identifier, e.g. an enum value or field name
  | { kind: "function"; name: string; args: AttributeArgValue[] } // e.g. now(), autoincrement()
  | { kind: "array"; items: AttributeArgValue[] };

export interface DefaultValue {
  /** A scalar literal default. */
  literal?: string | number | boolean;
  /** A function default such as now(), uuid(), cuid(), autoincrement(). */
  function?: { name: string; args: AttributeArgValue[] };
}

export interface RelationInfo {
  /** Relation name (@relation("name")). */
  name?: string;
  /** Local fields participating in the FK (`fields: [...]`). */
  fields?: string[];
  /** Referenced fields on the other model (`references: [...]`). */
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export type ReferentialAction =
  | "Cascade"
  | "Restrict"
  | "NoAction"
  | "SetNull"
  | "SetDefault";

export interface NativeType {
  /** e.g. "VarChar", "Decimal". */
  name: string;
  /** e.g. [255] or [18, 4]. */
  args: number[];
}

export interface FieldNode {
  name: string;
  /** Resolved type name: a ScalarType, an enum name, or a model name. */
  type: string;
  kind: FieldKind;
  isList: boolean;
  isRequired: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  /** Column name in the database (@map). Defaults to `name`. */
  dbName?: string;
  default?: DefaultValue;
  relation?: RelationInfo;
  nativeType?: NativeType;
  /** documentation/comment attached above the field (///). */
  documentation?: string;
}

export interface UniqueIndex {
  name?: string;
  fields: string[];
}

export interface IndexNode {
  name?: string;
  fields: string[];
  unique: boolean;
}

export interface ModelNode {
  name: string;
  /** Table name in the database (@@map). Defaults to `name`. */
  dbName?: string;
  fields: FieldNode[];
  /** Names of fields forming the primary key (composite supported via @@id). */
  primaryKey: string[];
  uniqueIndexes: UniqueIndex[];
  indexes: IndexNode[];
  documentation?: string;
}

export interface EnumNode {
  name: string;
  dbName?: string;
  values: { name: string; dbName?: string }[];
  documentation?: string;
}

export interface DatasourceNode {
  name: string;
  provider: string;
  /** Raw url expression; env("X") resolved at runtime. */
  url: { kind: "literal" | "env"; value: string };
}

export interface GeneratorNode {
  name: string;
  provider: string;
  output?: string;
  config: Record<string, string>;
}

export interface SchemaDocument {
  datasource?: DatasourceNode;
  generators: GeneratorNode[];
  models: ModelNode[];
  enums: EnumNode[];
}

export function emptySchema(): SchemaDocument {
  return { generators: [], models: [], enums: [] };
}

export function findModel(
  schema: SchemaDocument,
  name: string,
): ModelNode | undefined {
  return schema.models.find((m) => m.name === name);
}

export function findEnum(
  schema: SchemaDocument,
  name: string,
): EnumNode | undefined {
  return schema.enums.find((e) => e.name === name);
}

/**
 * Physical column name. Firebird folds unquoted identifiers to UPPER CASE, and
 * EmberORM always quotes identifiers, so a field without an explicit `@map`
 * resolves to its UPPER-CASED name to match the stored column. Use `@map` to
 * target a column created with case-sensitive (quoted) lower/mixed case.
 */
export function fieldColumn(field: FieldNode): string {
  return field.dbName ?? field.name.toUpperCase();
}

/** Physical table name; same UPPER-CASE folding rule as {@link fieldColumn}. */
export function modelTable(model: ModelNode): string {
  return model.dbName ?? model.name.toUpperCase();
}

/** Returns scalar fields only (excludes relation/object fields). */
export function scalarFields(model: ModelNode): FieldNode[] {
  return model.fields.filter((f) => f.kind !== "object");
}

/** Returns relation (object) fields only. */
export function relationFields(model: ModelNode): FieldNode[] {
  return model.fields.filter((f) => f.kind === "object");
}

export function idFields(model: ModelNode): FieldNode[] {
  if (model.primaryKey.length > 0) {
    return model.primaryKey
      .map((n) => model.fields.find((f) => f.name === n))
      .filter((f): f is FieldNode => !!f);
  }
  return model.fields.filter((f) => f.isId);
}
