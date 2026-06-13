import type { NativeType, ScalarType } from "@ember/ast";
import type { RawColumn } from "./firebird-meta";

// Firebird RDB$FIELD_TYPE codes.
const FB = {
  SMALLINT: 7,
  INTEGER: 8,
  QUAD: 9,
  FLOAT: 10,
  DATE_LEGACY: 11,
  DATE: 12,
  TIME: 13,
  CHAR: 14,
  INT64: 16, // BIGINT / numeric
  BOOLEAN: 23,
  DOUBLE: 27,
  TIMESTAMP: 35,
  VARCHAR: 37,
  BLOB: 261,
} as const;

export interface MappedType {
  scalar: ScalarType;
  native?: NativeType;
}

/**
 * Translate a Firebird column type into an EmberORM scalar type plus the native
 * type annotation (`@db.*`) that preserves the exact column definition.
 */
export function mapColumnType(col: RawColumn): MappedType {
  const scale = col.scale ?? 0;
  switch (col.fieldType) {
    case FB.SMALLINT:
      return scale < 0
        ? decimal(col)
        : { scalar: "Int", native: { name: "SmallInt", args: [] } };
    case FB.INTEGER:
      return scale < 0
        ? decimal(col)
        : { scalar: "Int", native: { name: "Integer", args: [] } };
    case FB.INT64:
      return scale < 0
        ? decimal(col)
        : { scalar: "BigInt", native: { name: "BigInt", args: [] } };
    case FB.FLOAT:
      return { scalar: "Float", native: { name: "Float", args: [] } };
    case FB.DOUBLE:
      return { scalar: "Float", native: { name: "DoublePrecision", args: [] } };
    case FB.BOOLEAN:
      return { scalar: "Boolean", native: { name: "Boolean", args: [] } };
    case FB.CHAR:
      return {
        scalar: "String",
        native: { name: "Char", args: col.charLength ? [col.charLength] : [] },
      };
    case FB.VARCHAR:
      return {
        scalar: "String",
        native: { name: "VarChar", args: col.charLength ? [col.charLength] : [] },
      };
    case FB.DATE:
    case FB.DATE_LEGACY:
      return { scalar: "DateTime", native: { name: "Date", args: [] } };
    case FB.TIME:
      return { scalar: "DateTime", native: { name: "Time", args: [] } };
    case FB.TIMESTAMP:
      return { scalar: "DateTime", native: { name: "Timestamp", args: [] } };
    case FB.BLOB:
      // sub_type 1 is a text blob.
      return col.fieldSubType === 1
        ? { scalar: "String", native: { name: "Text", args: [] } }
        : { scalar: "Bytes", native: { name: "Blob", args: [] } };
    default:
      return { scalar: "String" };
  }
}

function decimal(col: RawColumn): MappedType {
  const precision = col.precision ?? 18;
  const scaleAbs = Math.abs(col.scale ?? 0);
  return {
    scalar: "Decimal",
    native: { name: "Decimal", args: [precision, scaleAbs] },
  };
}
