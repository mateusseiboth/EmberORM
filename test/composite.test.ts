import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import { FirebirdDialect } from "@ember/sql";
import { QueryEngine, resolveRelation } from "@ember/query";
import { findModel } from "@ember/ast";
import type {
  SqlDriver,
  TransactionContext,
  TransactionOptions,
} from "@ember/driver";

// Order has a composite primary key (tenantId, id); OrderItem references it
// with a composite foreign key.
const SCHEMA = `model Order {
  tenantId Int
  id       Int
  total    Int
  items    OrderItem[]

  @@id([tenantId, id])
}

model OrderItem {
  tenantId Int
  sku      String
  orderId  Int
  order    Order  @relation(fields: [tenantId, orderId], references: [tenantId, id])

  @@id([tenantId, sku])
}`;

interface Recorded {
  sql: string;
  params: unknown[];
}

class MockDriver implements SqlDriver {
  public calls: Recorded[] = [];
  constructor(private handlers: [RegExp, (params: unknown[]) => any[]][]) {}
  async connect() {}
  async disconnect() {}
  async transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    _o?: TransactionOptions,
  ): Promise<T> {
    const tx: TransactionContext = {
      query: async (sql, params = []) => {
        this.calls.push({ sql, params: [...params] });
        for (const [re, rows] of this.handlers) {
          if (re.test(sql)) return rows([...params]) as any;
        }
        throw new Error(`No mock handler for SQL: ${sql}`);
      },
    };
    return fn(tx);
  }
}

const doc = parseSchema(SCHEMA);
const dialect = new FirebirdDialect();

describe("composite-key relations", () => {
  it("resolves both sides of a composite relation", () => {
    const order = findModel(doc, "Order")!;
    const item = findModel(doc, "OrderItem")!;

    const owning = resolveRelation(doc, item, item.fields.find((f) => f.name === "order")!);
    expect(owning.owns).toBe(true);
    expect(owning.fromColumns).toEqual(["TENANTID", "ORDERID"]);
    expect(owning.toColumns).toEqual(["TENANTID", "ID"]);

    const back = resolveRelation(doc, order, order.fields.find((f) => f.name === "items")!);
    expect(back.owns).toBe(false);
    expect(back.isList).toBe(true);
    expect(back.fromColumns).toEqual(["TENANTID", "ID"]);
    expect(back.toColumns).toEqual(["TENANTID", "ORDERID"]);
  });

  it("stitches a composite-key include via OR-of-AND groups", async () => {
    const driver = new MockDriver([
      [
        /FROM "ORDER"/,
        () => [
          { tenantId: 1, id: 10, total: 100 },
          { tenantId: 1, id: 11, total: 200 },
          { tenantId: 2, id: 10, total: 300 },
        ],
      ],
      [
        /FROM "ORDERITEM"/,
        () => [
          { tenantId: 1, sku: "A", orderId: 10 },
          { tenantId: 1, sku: "B", orderId: 10 },
          { tenantId: 1, sku: "C", orderId: 11 },
          { tenantId: 2, sku: "D", orderId: 10 },
        ],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);

    const orders = await engine.findMany("Order", { include: { items: true } });
    // (1,10) gets A,B; (1,11) gets C; (2,10) gets D — note (1,10) != (2,10).
    expect((orders[0]!.items as any[]).map((i) => i.sku)).toEqual(["A", "B"]);
    expect((orders[1]!.items as any[]).map((i) => i.sku)).toEqual(["C"]);
    expect((orders[2]!.items as any[]).map((i) => i.sku)).toEqual(["D"]);

    const childCall = driver.calls.find((c) => /FROM "ORDERITEM"/.test(c.sql))!;
    // Composite key => OR of AND-ed equality groups (no row-value IN).
    expect(childCall.sql).toContain("OR");
    expect(childCall.sql).toContain('"TENANTID"');
    expect(childCall.sql).toContain('"ORDERID"');
    expect(childCall.sql).not.toContain("IN (");
    // 3 distinct parent tuples * 2 columns = 6 bound params.
    expect(childCall.params).toEqual([1, 10, 1, 11, 2, 10]);
  });

  it("create writes a composite foreign key from a nested parent connect", async () => {
    const driver = new MockDriver([
      // connect lookup returns the parent composite key
      [/SELECT FIRST 1.*FROM "ORDER"/s, () => [{ tenantId: 7, id: 99 }]],
      [/INSERT INTO "ORDERITEM"/, () => [{ tenantId: 7, sku: "X" }]],
      [/FROM "ORDERITEM"/, () => [{ tenantId: 7, sku: "X", orderId: 99 }]],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const item = await engine.create("OrderItem", {
      data: { sku: "X", order: { connect: { tenantId: 7, id: 99 } } },
    });
    expect(item.orderId).toBe(99);
    expect(item.tenantId).toBe(7);

    const insert = driver.calls.find((c) => /INSERT INTO "ORDERITEM"/.test(c.sql))!;
    expect(insert.sql).toContain('"TENANTID"');
    expect(insert.sql).toContain('"ORDERID"');
    expect(insert.params).toContain(99);
  });
});
