import { type FieldNode } from "@ember/ast";

/**
 * Map a raw value returned by node-firebird into the JS type implied by the
 * field's schema type. Firebird has no native boolean in older versions and
 * returns JSON/decimal as text, so normalization happens here in one place.
 */
export function coerceFromDb(value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;

  switch (field.type) {
    case "Boolean":
      return toBoolean(value);
    case "Int":
      return typeof value === "number" ? value : Number(value);
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(String(value));
    case "Float":
    case "Decimal":
      return typeof value === "number" ? value : Number(value);
    case "DateTime":
      return value instanceof Date ? value : new Date(String(value));
    case "Json":
      return parseJson(value);
    case "Bytes":
      return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    case "String":
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** Map a full DB row keyed by field name into a typed plain object. */
export function coerceRow(
  row: Record<string, unknown>,
  fields: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name in row) {
      out[field.name] = coerceFromDb(row[field.name], field);
    }
  }
  return out;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toUpperCase();
  return s === "1" || s === "T" || s === "TRUE" || s === "Y";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
