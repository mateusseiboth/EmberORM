import { describe, expect, it } from "vitest";
import { findModel } from "@ember/ast";
import type {
  SqlDriver,
  SqlValue,
  TransactionContext,
  TransactionOptions,
} from "@ember/driver";
import { QueryValidationError, SchemaValidationError } from "@ember/errors";
import { generateClientSource } from "@ember/generator";
import { Introspector } from "@ember/introspect";
import { QueryEngine, resolveRelation } from "@ember/query";
import { parseAndValidate, parseSchema, printSchema } from "@ember/schema";
import { FirebirdDialect } from "@ember/sql";

const SCHEMA = `model Bairro {
  id    Int                @id @map("BAI_CODIGO")
  nome  String             @map("BAI_DESCRICAO")
  links LogradouroBairro[]

  @@map("SIA_BAIRRO")
}

/// Legacy table without a primary key.
model LogradouroBairro {
  logCodigo Int    @map("LOG_CODIGO")
  baiCodigo Int    @map("BAI_CODIGO")
  bairro    Bairro @relation(fields: [baiCodigo], references: [id])

  @@ignoreId
  @@map("SIA_LOGRADOURO_BAIRRO")
}`;

const doc = parseAndValidate(SCHEMA);
const dialect = new FirebirdDialect();

interface Recorded {
  sql: string;
  params: unknown[];
}

class MockDriver implements SqlDriver {
  public calls: Recorded[] = [];
  constructor(private handlers: [RegExp, (params: unknown[]) => any[]][] = []) {}

  async connect() {}
  async disconnect() {}

  async transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    _o?: TransactionOptions,
  ): Promise<T> {
    const tx: TransactionContext = {
      query: async (sql, params = []) => {
        this.calls.push({ sql, params: [...params] });
        const handler = this.handlers.find(([re]) => re.test(sql));
        return (handler ? handler[1]([...params]) : []) as any;
      },
    };
    return fn(tx);
  }
}

describe("keyless model: schema", () => {
  it("still rejects a model without a primary key and points to @@ignoreId", () => {
    const source = `model Log {\n  msg String\n}`;
    expect(() => parseAndValidate(source)).toThrow(SchemaValidationError);
    expect(() => parseAndValidate(source)).toThrow(/@@ignoreId/);
  });

  it("accepts a model without a primary key when it declares @@ignoreId", () => {
    const model = findModel(doc, "LogradouroBairro")!;
    expect(model.ignoreId).toBe(true);
    expect(model.primaryKey).toEqual([]);
  });

  it("rejects @@ignoreId on a model that does have a primary key", () => {
    const source = `model Log {\n  id Int @id\n  @@ignoreId\n}`;
    expect(() => parseAndValidate(source)).toThrow(/@@ignoreId/);
  });

  it("prints @@ignoreId and round-trips it", () => {
    const printed = printSchema(doc);
    expect(printed).toContain("  @@ignoreId\n");
    expect(parseSchema(printed)).toEqual(doc);
  });
});

/** Catalog answers for one table with two INTEGER columns and no constraints. */
function keylessDriver(): SqlDriver {
  const tx: TransactionContext = {
    query: async <T>(text: string, _params?: readonly SqlValue[]) => {
      if (/ENGINE_VERSION/.test(text)) return [{ V: "2.1.7" }] as T[];
      if (/RDB\$RELATION_FIELDS/.test(text)) {
        return ["LOG_CODIGO", "BAI_CODIGO"].map((name, i) => ({
          TABLE_NAME: "SIA_ANO_ALVARA",
          FIELD_NAME: name,
          FIELD_POSITION: i,
          NULL_FLAG: 1,
          DEFAULT_SOURCE: null,
          FIELD_TYPE: 8,
          FIELD_SUB_TYPE: 0,
          FIELD_LENGTH: 4,
          CHAR_LEN: null,
          FIELD_PRECISION: 0,
          FIELD_SCALE: 0,
        })) as T[];
      }
      if (/FROM RDB\$RELATIONS/.test(text)) {
        return [{ "RDB$RELATION_NAME": "SIA_ANO_ALVARA" }] as T[];
      }
      return [] as T[];
    },
  };
  return {
    transaction: async (fn: (t: TransactionContext) => Promise<unknown>) => fn(tx),
  } as unknown as SqlDriver;
}

describe("keyless model: db pull", () => {
  it("marks a table without a primary key with @@ignoreId and a /// note", async () => {
    const pulled = await new Introspector(keylessDriver()).introspect();
    const model = pulled.models[0]!;
    expect(model.ignoreId).toBe(true);
    expect(model.documentation).toMatch(/no primary key/i);

    const printed = printSchema(pulled);
    expect(printed).toMatch(/\/\/\/ .*no primary key/i);
    expect(printed).toContain("@@ignoreId");
    expect(() => parseAndValidate(printed)).not.toThrow();
  });
});

function delegateBlock(source: string, model: string): string {
  const start = source.indexOf(`export interface ${model}Delegate {`);
  return source.slice(start, source.indexOf("\n  }", start));
}

describe("keyless model: generated client", () => {
  const src = generateClientSource(doc);
  const keyless = delegateBlock(src, "LogradouroBairro");

  it("generates the bulk / non-identity operations", () => {
    for (const op of [
      "findMany",
      "findFirst",
      "findFirstOrThrow",
      "createMany",
      "updateMany",
      "deleteMany",
      "count",
      "aggregate",
      "groupBy",
    ]) {
      expect(keyless).toMatch(new RegExp(`\\n\\s+${op}[<(]`));
    }
  });

  it("does not generate operations that need a unique where or a read-back by key", () => {
    for (const op of [
      "findUnique",
      "findUniqueOrThrow",
      "create",
      "createManyAndReturn",
      "update",
      "upsert",
      "delete",
    ]) {
      expect(keyless).not.toMatch(new RegExp(`\\n\\s+${op}<`));
    }
    // keyed models keep the full surface
    expect(delegateBlock(src, "Bairro")).toMatch(/\n\s+findUnique</);
  });

  it("nested writes into a keyless child only allow create", () => {
    const createInput = src.slice(src.indexOf("export type BairroCreateInput"));
    const linksLine = createInput.split("\n").find((l) => l.includes("links?:"))!;
    expect(linksLine).toContain("create?:");
    expect(linksLine).not.toContain("connect");
  });
});

describe("keyless model: engine", () => {
  it("findMany includes the to-one parent of a keyless row", async () => {
    const driver = new MockDriver([
      [/FROM "SIA_LOGRADOURO_BAIRRO"/, () => [{ logCodigo: 7, baiCodigo: 1 }]],
      [/FROM "SIA_BAIRRO"/, () => [{ id: 1, nome: "Centro" }]],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const rows = await engine.findMany("LogradouroBairro", {
      take: 3,
      include: { bairro: true },
    });
    expect(rows).toEqual([
      { logCodigo: 7, baiCodigo: 1, bairro: { id: 1, nome: "Centro" } },
    ]);
  });

  it("findMany includes keyless children of a keyed parent", async () => {
    const driver = new MockDriver([
      [/FROM "SIA_BAIRRO"/, () => [{ id: 1, nome: "Centro" }]],
      [
        /FROM "SIA_LOGRADOURO_BAIRRO"/,
        () => [
          { logCodigo: 7, baiCodigo: 1 },
          { logCodigo: 8, baiCodigo: 1 },
        ],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const [bairro] = await engine.findMany("Bairro", { include: { links: true } });
    expect((bairro!.links as unknown[]).length).toBe(2);
  });

  it("count, createMany, updateMany and deleteMany work without a key", async () => {
    const driver = new MockDriver([[/COUNT/, () => [{ _count: 2 }]]]);
    const engine = new QueryEngine(doc, dialect, driver);

    expect(await engine.count("LogradouroBairro")).toBe(2);
    expect(
      await engine.createMany("LogradouroBairro", {
        data: [{ logCodigo: 1, baiCodigo: 1 }],
      }),
    ).toEqual({ count: 1 });
    await engine.updateMany("LogradouroBairro", {
      where: { logCodigo: 1 },
      data: { baiCodigo: 2 },
    });
    await engine.deleteMany("LogradouroBairro", { where: { logCodigo: 1 } });

    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.sql).not.toContain("RETURNING");
    expect(driver.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(true);
    expect(driver.calls.some((c) => c.sql.startsWith("DELETE"))).toBe(true);
  });

  it("rejects identity-based operations with a clear error and runs no SQL", async () => {
    const driver = new MockDriver();
    const engine = new QueryEngine(doc, dialect, driver);
    const where = { logCodigo: 1 };
    const data = { logCodigo: 1, baiCodigo: 1 };
    const attempts = [
      () => engine.findUnique("LogradouroBairro", { where }),
      () => engine.findUniqueOrThrow("LogradouroBairro", { where }),
      () => engine.create("LogradouroBairro", { data }),
      () => engine.createManyAndReturn("LogradouroBairro", { data: [data] }),
      () => engine.update("LogradouroBairro", { where, data }),
      () => engine.upsert("LogradouroBairro", { where, create: data, update: data }),
      () => engine.delete("LogradouroBairro", { where }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(QueryValidationError);
      await expect(attempt()).rejects.toThrow(/no primary key/);
    }
    expect(driver.calls).toEqual([]);
  });

  it("rejects nested connect into a keyless child", async () => {
    const engine = new QueryEngine(doc, dialect, new MockDriver());
    await expect(
      engine.create("Bairro", {
        data: { id: 2, nome: "Novo", links: { connect: { logCodigo: 1 } } },
      }),
    ).rejects.toThrow(/no primary key/);
  });
});

describe("keyless model: relation resolution", () => {
  it("refuses an implicit (key-based) relation to a keyless model", () => {
    const implicit = parseSchema(`model A {
  id Int @id
  b  B?
}

model B {
  aId Int
  a   A

  @@ignoreId
}`);
    const a = findModel(implicit, "A")!;
    const field = a.fields.find((f) => f.name === "b")!;
    expect(() => resolveRelation(implicit, a, field)).toThrow(QueryValidationError);
  });
});
