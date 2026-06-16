import type { BytesToken, StudioField } from "./types";

function isBytesToken(v: unknown): v is BytesToken {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as BytesToken).$type === "bytes" &&
    typeof (v as BytesToken).base64 === "string"
  );
}

/** Human-readable rendering of a serialized cell value. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isBytesToken(value)) return `‹bytes ${value.base64.length}b›`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Value to seed a text/checkbox input with when editing a cell. */
export function editValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Parse a form input string back into the JSON shape the API expects for a
 * field. Empty input becomes `null` (for nullable fields) or is left to the
 * server to default. Returns `undefined` to mean "omit this field".
 */
export function parseInput(
  field: StudioField,
  raw: string,
  touched: boolean,
): unknown {
  if (!touched) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return field.isRequired ? undefined : null;

  switch (field.type) {
    case "Int":
    case "BigInt":
      return field.type === "BigInt" ? trimmed : Number.parseInt(trimmed, 10);
    case "Float":
    case "Decimal":
      return Number(trimmed);
    case "Boolean":
      return trimmed === "true" || trimmed === "1";
    case "Json":
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    default:
      // String, DateTime (ISO string), enum names, Bytes (base64) pass through.
      return trimmed;
  }
}

/** Input control type best suited to a field. */
export function inputKind(field: StudioField): "checkbox" | "select" | "datetime" | "text" {
  if (field.type === "Boolean") return "checkbox";
  if (field.kind === "enum") return "select";
  if (field.type === "DateTime") return "datetime";
  return "text";
}
