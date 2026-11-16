import { describe, expect, it } from "vitest";
import type { SqlDriver, SqlValue, TransactionContext } from "@ember/driver";
import { findModel } from "@ember/ast";
import { Introspector } from "@ember/introspect";
import { FirebirdDdl } from "@ember/migrate";
import { applyCreateDefaults } from "@ember/query";
import { parseSchema, printSchema } from "@ember/schema";
import { FirebirdDialect } from "@ember/sql";

const SCHEMA = `enum Role {
  USER
  ADMIN
}

model Account {
  id     Int    @id
  role   Role   @default(ADMIN)
  ativa  String @default("S")
  quoted String @default("say \\"hi\\" \\\\ ok")
}`;

function fieldOf(source: string, name: string) {
  return findModel(parseSchema(source), "Account")!.fields.find((f) => f.name === name)!;
}

/** A driver that answers the catalog queries with one CHAR(1) column and its DEFAULT source. */
function fakeDriver(defaultSource: string): SqlDriver {
  const tx: TransactionContext = {
    query: async <T>(text: string, _params?: readonly SqlValue[]) => {
      if (/ENGINE_VERSION/.test(text)) return [{ V: "2.1.7" }] as T[];
      if (/RDB\$RELATION_FIELDS/.test(text)) {
        return [
          {
            TABLE_NAME: "SIA_CONFIG",
            FIELD_NAME: "ATIVA",
            FIELD_POSITION: 0,
            NULL_FLAG: null,
            DEFAULT_SOURCE: defaultSource,
            FIELD_TYPE: 14,
            FIELD_SUB_TYPE: 0,
            FIELD_LENGTH: 1,
            CHAR_LEN: 1,
            FIELD_PRECISION: null,
            FIELD_SCALE: 0,
          },
        ] as T[];
      }
      if (/FROM RDB\$RELATIONS/.test(text)) return [{ "RDB$RELATION_NAME": "SIA_CONFIG" }] as T[];
      return [] as T[];
    },
  };
  return {
    transaction: async (fn: (t: TransactionContext) => Promise<unknown>) => fn(tx),
  } as unknown as SqlDriver;
}

describe("@default: string literal vs enum value", () => {
  it("parses a quoted default as a string literal and a bare identifier as an enum value", () => {
    expect(fieldOf(SCHEMA, "ativa").default).toEqual({ literal: "S" });
    expect(fieldOf(SCHEMA, "role").default).toEqual({ enumValue: "ADMIN" });
  });

  it("prints a string literal quoted (even when it looks like an identifier) and an enum value bare", () => {
    const printed = printSchema(parseSchema(SCHEMA));
    expect(printed).toMatch(/ativa\s+String\s+@default\("S"\)/);
    expect(printed).toMatch(/role\s+Role\s+@default\(ADMIN\)/);
  });

  it("round-trips both kinds (and escaped strings) through parse -> print -> parse", () => {
    const once = parseSchema(printSchema(parseSchema(SCHEMA)));
    expect(once).toEqual(parseSchema(SCHEMA));
    expect(findModel(once, "Account")!.fields.find((f) => f.name === "quoted")!.default).toEqual({
      literal: 'say "hi" \\ ok',
    });
  });

  it("db pull prints a CHAR DEFAULT 'S' as @default(\"S\")", async () => {
    const doc = await new Introspector(fakeDriver("DEFAULT 'S'")).introspect();
    const printed = printSchema(doc);
    expect(printed).toContain('@default("S")');
    expect(findModel(parseSchema(printed), "SiaConfig")!.fields[0]!.default).toEqual({
      literal: "S",
    });
  });

  it("db pull unescapes doubled quotes in a SQL string default", async () => {
    const doc = await new Introspector(fakeDriver("DEFAULT 'it''s'")).introspect();
    expect(doc.models[0]!.fields[0]!.default).toEqual({ literal: "it's" });
  });

  it("migrate DDL quotes both a string literal and an enum value default", () => {
    const ddl = new FirebirdDdl(new FirebirdDialect());
    expect(ddl.columnDefinition(fieldOf(SCHEMA, "ativa"))).toContain("DEFAULT 'S'");
    expect(ddl.columnDefinition(fieldOf(SCHEMA, "role"))).toContain("DEFAULT 'ADMIN'");
  });

  it("the client fills both defaults on create", () => {
    const model = findModel(parseSchema(SCHEMA), "Account")!;
    expect(applyCreateDefaults(model, { id: 1 })).toMatchObject({ role: "ADMIN", ativa: "S" });
  });
});
