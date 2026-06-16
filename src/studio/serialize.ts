/**
 * JSON serialization boundary for EmberStudio.
 *
 * The query engine returns rows already coerced to rich JS types
 * (`Date`, `BigInt`, `Buffer`) — see `src/query/coerce.ts`. Those do not survive
 * `JSON.stringify` natively (`BigInt` throws; `Buffer`/`Date` lose their shape),
 * so the Studio HTTP API serializes them to portable tokens on the way out and
 * parses them back per `FieldNode` on the way in.
 */
import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  findModel,
} from "@ember/ast";

/** A binary value encoded for transport (Firebird BLOB / bytes columns). */
export interface BytesToken {
  $type: "bytes";
  base64: string;
}

function isBytesToken(value: unknown): value is BytesToken {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $type?: unknown }).$type === "bytes" &&
    typeof (value as { base64?: unknown }).base64 === "string"
  );
}

/** Convert a single engine value into a JSON-safe representation. */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return { $type: "bytes", base64: value.toString("base64") } satisfies BytesToken;
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a row returned by the engine. Relation values (objects/arrays from
 * `include`) are walked recursively by {@link serializeValue}, so no per-field
 * model lookup is required here.
 */
export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return serializeValue(row) as Record<string, unknown>;
}

export function serializeRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map(serializeRow);
}

/** Parse one incoming JSON value into the JS type the engine expects. */
export function deserializeValue(field: FieldNode, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isBytesToken(value)) return Buffer.from(value.base64, "base64");

  // Object/relation fields (e.g. nested `connect`) pass through untouched.
  if (field.kind === "object") return value;

  switch (field.type) {
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(String(value));
    case "DateTime":
      return value instanceof Date ? value : new Date(String(value));
    case "Int":
      return typeof value === "number" ? value : Number.parseInt(String(value), 10);
    case "Float":
    case "Decimal":
      return typeof value === "number" ? value : Number(String(value));
    case "Boolean":
      if (typeof value === "boolean") return value;
      return value === "true" || value === 1 || value === "1";
    case "Bytes":
      return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "base64");
    default:
      // String, enums, Json — pass through as-is.
      return value;
  }
}

/**
 * Deserialize a `data` payload for `create`/`update` against `modelName`. Keys
 * not matching a scalar field (relation operations, unknown keys) are left
 * untouched so the engine can validate them.
 */
export function deserializeData(
  data: Record<string, unknown>,
  modelName: string,
  schema: SchemaDocument,
): Record<string, unknown> {
  const model = findModel(schema, modelName);
  if (!model) return data;
  const byName = fieldIndex(model);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = byName.get(key);
    out[key] = field ? deserializeValue(field, value) : value;
  }
  return out;
}

/**
 * Deserialize a `where` payload. Only top-level scalar-field conditions are
 * converted (direct equality `{ field: value }` and the `equals`/`in`/`not`
 * operator forms), which covers Studio's filter bar and primary-key lookups for
 * `Date`/`BigInt`/`Bytes` columns. Logical groups (`AND`/`OR`/`NOT`) and other
 * operators are left for the engine to validate.
 */
export function deserializeWhere(
  where: Record<string, unknown> | undefined,
  modelName: string,
  schema: SchemaDocument,
): Record<string, unknown> | undefined {
  if (!where) return where;
  const model = findModel(schema, modelName);
  if (!model) return where;
  const byName = fieldIndex(model);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    const field = byName.get(key);
    if (!field || field.kind === "object") {
      out[key] = value;
      continue;
    }
    out[key] = deserializeCondition(field, value);
  }
  return out;
}

function deserializeCondition(field: FieldNode, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !isBytesToken(value)) {
    const cond = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [op, operand] of Object.entries(cond)) {
      if ((op === "in" || op === "notIn") && Array.isArray(operand)) {
        out[op] = operand.map((v) => deserializeValue(field, v));
      } else if (op === "equals" || op === "not" || op === "lt" || op === "lte" || op === "gt" || op === "gte") {
        out[op] = deserializeValue(field, operand);
      } else {
        out[op] = operand;
      }
    }
    return out;
  }
  return deserializeValue(field, value);
}

function fieldIndex(model: ModelNode): Map<string, FieldNode> {
  return new Map(model.fields.map((f) => [f.name, f]));
}
