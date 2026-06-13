import {
  type FieldNode,
  type ScalarType,
  type SchemaDocument,
} from "@ember/ast";

const SCALAR_TS: Record<ScalarType, string> = {
  String: "string",
  Boolean: "boolean",
  Int: "number",
  BigInt: "bigint",
  Float: "number",
  Decimal: "number",
  DateTime: "Date",
  Bytes: "Buffer",
  Json: "JsonValue",
};

/** TS type for a scalar/enum field value (without null/array decoration). */
export function baseTsType(field: FieldNode, schema: SchemaDocument): string {
  if (field.kind === "enum") return field.type;
  if (field.kind === "object") return field.type;
  return SCALAR_TS[field.type as ScalarType] ?? "unknown";
}

/** Full TS type for a field, including null and array decoration. */
export function fieldTsType(field: FieldNode, schema: SchemaDocument): string {
  const base = baseTsType(field, schema);
  if (field.isList) return `${base}[]`;
  return field.isRequired ? base : `${base} | null`;
}

/** TS type usable as a filter value for a scalar field. */
export function scalarFilterType(field: FieldNode): string {
  const base = SCALAR_TS[field.type as ScalarType] ?? "unknown";
  return base;
}
