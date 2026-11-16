import { describe, expect, it } from "vitest";
import type { SqlDriver, SqlValue, TransactionContext } from "@ember/driver";
import { Introspector } from "@ember/introspect";
import { parseSchema, printSchema } from "@ember/schema";

/** A driver that answers the catalog queries with one table and the given columns. */
function fakeDriver(table: string, columnNames: string[]): SqlDriver {
  const tx: TransactionContext = {
    query: async <T>(text: string, _params?: readonly SqlValue[]) => {
      if (/ENGINE_VERSION/.test(text)) return [{ V: "2.5.9" }] as T[];
      if (/RDB\$RELATION_FIELDS/.test(text)) {
        return columnNames.map((name, i) => ({
          TABLE_NAME: table,
          FIELD_NAME: name,
          FIELD_POSITION: i,
          NULL_FLAG: null,
          DEFAULT_SOURCE: null,
          FIELD_TYPE: 37,
          FIELD_SUB_TYPE: 0,
          FIELD_LENGTH: 50,
          CHAR_LEN: 50,
          FIELD_PRECISION: null,
          FIELD_SCALE: 0,
        })) as T[];
      }
      if (/FROM RDB\$RELATIONS/.test(text)) return [{ "RDB$RELATION_NAME": table }] as T[];
      return [] as T[];
    },
  };
  return {
    transaction: async (fn: (t: TransactionContext) => Promise<unknown>) => fn(tx),
  } as unknown as SqlDriver;
}

describe("Introspector field names", () => {
  it("never emits a field name starting with a digit (Firebird allows quoted 1VIADESCRICAO)", async () => {
    const doc = await new Introspector(
      fakeDriver("SIA_NFISCAL_VIAS", ["NVIAS", "1VIADESCRICAO"]),
    ).introspect();

    const field = doc.models[0]!.fields.find((f) => f.dbName === "1VIADESCRICAO");
    expect(field?.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it("prints a schema that parses back when a column starts with a digit", async () => {
    const doc = await new Introspector(
      fakeDriver("SIA_NFISCAL_VIAS", ["NVIAS", "1VIADESCRICAO"]),
    ).introspect();

    expect(() => parseSchema(printSchema(doc))).not.toThrow();
  });
});
