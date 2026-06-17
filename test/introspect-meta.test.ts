import { describe, expect, it } from "vitest";
import type { SqlValue, TransactionContext } from "@ember/driver";
import { FirebirdMetadataReader } from "@ember/introspect";

/** Captures executed SQL and replies based on the engine version it reports. */
function fakeTx(engineVersion: string): {
  tx: TransactionContext;
  sql: string[];
} {
  const sql: string[] = [];
  const tx: TransactionContext = {
    query: async <T>(text: string, _params?: readonly SqlValue[]) => {
      sql.push(text);
      if (/ENGINE_VERSION/.test(text)) return [{ V: engineVersion }] as T[];
      return [] as T[];
    },
  };
  return { tx, sql };
}

describe("FirebirdMetadataReader.columns", () => {
  it("never aliases a column to the reserved word CHAR_LENGTH", async () => {
    const { tx, sql } = fakeTx("3.0.7");
    await new FirebirdMetadataReader(tx).columns();
    const columnsSql = sql.find((s) => /RDB\$RELATION_FIELDS/.test(s))!;
    expect(columnsSql).toContain("AS CHAR_LEN");
    expect(columnsSql).not.toMatch(/AS\s+CHAR_LENGTH\b/);
  });

  it("casts the RDB$DEFAULT_SOURCE BLOB to VARCHAR (node-firebird BLOB crash)", async () => {
    const { tx, sql } = fakeTx("3.0.7");
    await new FirebirdMetadataReader(tx).columns();
    const columnsSql = sql.find((s) => /RDB\$RELATION_FIELDS/.test(s))!;
    expect(columnsSql).toContain("CAST(rf.RDB$DEFAULT_SOURCE AS VARCHAR");
    expect(columnsSql).not.toMatch(/rf\.RDB\$DEFAULT_SOURCE\s+AS\s+DEFAULT_SOURCE/);
  });

  it("omits RDB$IDENTITY_TYPE on Firebird 2.5 (column does not exist)", async () => {
    const { tx, sql } = fakeTx("2.5.9");
    await new FirebirdMetadataReader(tx).columns();
    const columnsSql = sql.find((s) => /RDB\$RELATION_FIELDS/.test(s))!;
    expect(columnsSql).not.toContain("RDB$IDENTITY_TYPE");
  });

  it("includes RDB$IDENTITY_TYPE on Firebird 3.0+", async () => {
    const { tx, sql } = fakeTx("3.0.7");
    await new FirebirdMetadataReader(tx).columns();
    const columnsSql = sql.find((s) => /RDB\$RELATION_FIELDS/.test(s))!;
    expect(columnsSql).toContain("RDB$IDENTITY_TYPE");
  });

  it("detects trigger-based autoincrement columns (Firebird 2.x identity)", async () => {
    const sql: string[] = [];
    const tx: TransactionContext = {
      query: async <T>(text: string) => {
        sql.push(text);
        if (/RDB\$TRIGGERS/.test(text)) {
          return [
            {
              TABLE_NAME: "VENDAS_ENTREGA",
              SRC:
                "BEGIN\n  IF (NEW.\"IDVENDA\" IS NULL) THEN " +
                'NEW."IDVENDA" = GEN_ID("GEN_VENDAS_ENTREGA_IDVENDA", 1);\nEND',
            },
            {
              TABLE_NAME: "PEDIDO",
              SRC: "BEGIN NEW.ID = NEXT VALUE FOR GEN_PEDIDO; END",
            },
            // Not an autoincrement trigger: must be ignored.
            { TABLE_NAME: "LOG", SRC: "BEGIN NEW.TS = CURRENT_TIMESTAMP; END" },
          ] as T[];
        }
        return [] as T[];
      },
    };
    const auto = await new FirebirdMetadataReader(tx).autoincrementColumns();
    const triggersSql = sql.find((s) => /RDB\$TRIGGERS/.test(s))!;
    expect(triggersSql).toContain("RDB$TRIGGER_TYPE = 1"); // BEFORE INSERT
    expect(triggersSql).toContain("CAST(RDB$TRIGGER_SOURCE AS VARCHAR");
    expect(auto.has("VENDAS_ENTREGA.IDVENDA")).toBe(true);
    expect(auto.has("PEDIDO.ID")).toBe(true);
    expect(auto.has("LOG.TS")).toBe(false);
  });

  it("falls back to the conservative subset when version is unavailable", async () => {
    const sql: string[] = [];
    const tx: TransactionContext = {
      query: async <T>(text: string) => {
        sql.push(text);
        if (/ENGINE_VERSION/.test(text)) throw new Error("not supported");
        return [] as T[];
      },
    };
    await new FirebirdMetadataReader(tx).columns();
    const columnsSql = sql.find((s) => /RDB\$RELATION_FIELDS/.test(s))!;
    expect(columnsSql).not.toContain("RDB$IDENTITY_TYPE");
  });
});
