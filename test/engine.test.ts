import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import { FirebirdDialect } from "@ember/sql";
import { QueryEngine } from "@ember/query";
import type {
  SqlDriver,
  TransactionContext,
  TransactionOptions,
} from "@ember/driver";

const SCHEMA = `model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String?
  posts Post[]
  @@map("USERS")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("AUTHOR_ID")
  author   User   @relation(fields: [authorId], references: [id])
}`;

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * A scripted driver: each query is matched against an ordered list of
 * [regex -> rows] handlers. Lets us assert the engine's SQL and stitching
 * without a real database.
 */
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

describe("query engine reads", () => {
  it("findMany stitches a to-many include with a batched IN query", async () => {
    const driver = new MockDriver([
      [
        /FROM "USERS"/,
        () => [
          { id: 1, email: "a@x.com", name: "A" },
          { id: 2, email: "b@x.com", name: "B" },
        ],
      ],
      [
        /FROM "POST"/,
        () => [
          { id: 10, title: "P1", authorId: 1 },
          { id: 11, title: "P2", authorId: 1 },
          { id: 12, title: "P3", authorId: 2 },
        ],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);

    const users = await engine.findMany("User", { include: { posts: true } });
    expect(users).toHaveLength(2);
    expect((users[0]!.posts as any[]).map((p) => p.id)).toEqual([10, 11]);
    expect((users[1]!.posts as any[]).map((p) => p.id)).toEqual([12]);

    // The child query must filter by the parent keys via IN.
    const childCall = driver.calls.find((c) => /FROM "POST"/.test(c.sql))!;
    expect(childCall.sql).toContain('"AUTHOR_ID" IN (?, ?)');
    expect(childCall.params).toEqual([1, 2]);
  });

  it("attaches relation _count via a grouped child query", async () => {
    const driver = new MockDriver([
      [
        /FROM "USERS"/,
        () => [
          { id: 1, email: "a", name: "A" },
          { id: 2, email: "b", name: "B" },
        ],
      ],
      [
        /GROUP BY/,
        () => [
          { authorId: 1, _count_all: 3 },
          // user 2 has no posts -> absent -> defaults to 0
        ],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const users = await engine.findMany("User", {
      include: { _count: { select: { posts: true } } },
    });
    expect((users[0]!._count as any).posts).toBe(3);
    expect((users[1]!._count as any).posts).toBe(0);

    const countCall = driver.calls.find((c) => /GROUP BY/.test(c.sql))!;
    expect(countCall.sql).toContain("COUNT(*)");
    expect(countCall.sql).toContain('"AUTHOR_ID" IN (?, ?)');
  });

  it("findUnique returns null when no rows", async () => {
    const driver = new MockDriver([[/FROM "USERS"/, () => []]]);
    const engine = new QueryEngine(doc, dialect, driver);
    const user = await engine.findUnique("User", { where: { id: 999 } });
    expect(user).toBeNull();
  });

  it("count returns the scalar value", async () => {
    const driver = new MockDriver([[/COUNT/, () => [{ _count: 7 }]]]);
    const engine = new QueryEngine(doc, dialect, driver);
    expect(await engine.count("User", {})).toBe(7);
  });

  it("cursor adds a >= filter and orders by the cursor field", async () => {
    const driver = new MockDriver([
      [/FROM "USERS"/, () => [{ id: 5, email: "e", name: "n" }]],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    await engine.findMany("User", { cursor: { id: 5 }, take: 10 });
    const call = driver.calls.find((c) => /FROM "USERS"/.test(c.sql))!;
    expect(call.sql).toContain('"t0"."ID" >= ?');
    expect(call.sql).toContain('ORDER BY "t0"."ID" ASC');
    expect(call.sql).toContain("FIRST 10");
    expect(call.params).toContain(5);
  });

  it("distinct de-duplicates in memory and paginates after", async () => {
    const driver = new MockDriver([
      [
        /FROM "USERS"/,
        () => [
          { id: 1, email: "a@x.com", name: "Dup" },
          { id: 2, email: "a@x.com", name: "Dup" },
          { id: 3, email: "b@x.com", name: "Other" },
        ],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const rows = await engine.findMany("User", { distinct: ["name"], take: 5 });
    expect(rows.map((r) => r.name)).toEqual(["Dup", "Other"]);
    // distinct disables SQL pagination (done in memory instead)
    const call = driver.calls.find((c) => /FROM "USERS"/.test(c.sql))!;
    expect(call.sql).not.toContain("FIRST");
  });
});

describe("query engine writes", () => {
  it("create inserts and reads the row back", async () => {
    const inserted: Recorded[] = [];
    const driver = new MockDriver([
      [
        /INSERT INTO "USERS"/,
        () => [{ id: 42 }],
      ],
      [
        /FROM "USERS"/,
        () => [{ id: 42, email: "new@x.com", name: "New" }],
      ],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const user = await engine.create("User", {
      data: { email: "new@x.com", name: "New" },
    });
    expect(user.id).toBe(42);
    expect(user.email).toBe("new@x.com");

    const insertCall = driver.calls.find((c) => /INSERT/.test(c.sql))!;
    // autoincrement id omitted, RETURNING present, values bound as params
    expect(insertCall.sql).toContain('RETURNING "ID" AS "id"');
    expect(insertCall.params).toEqual(["new@x.com", "New"]);
    void inserted;
  });

  it("create resolves an owning relation via connect", async () => {
    const driver = new MockDriver([
      [/SELECT FIRST 1.*FROM "USERS"/s, () => [{ id: 7 }]], // connect lookup
      [/INSERT INTO "POST"/, () => [{ id: 100 }]],
      [/FROM "POST"/, () => [{ id: 100, title: "Hi", authorId: 7 }]],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const post = await engine.create("Post", {
      data: { title: "Hi", author: { connect: { id: 7 } } },
    });
    expect(post.authorId).toBe(7);
    const insertCall = driver.calls.find((c) => /INSERT INTO "POST"/.test(c.sql))!;
    // FK column AUTHOR_ID must be part of the insert, bound to 7
    expect(insertCall.sql).toContain('"AUTHOR_ID"');
    expect(insertCall.params).toContain(7);
  });

  it("update emits atomic numeric operators as col = col <op> ?", async () => {
    const counterSchema = parseSchema(`model Counter {
      id    Int @id
      views Int @default(0)
      score Int @default(0)
    }`);
    const driver = new MockDriver([
      [/FROM "COUNTER"/, () => [{ id: 1, views: 10, score: 4 }]],
      [/UPDATE "COUNTER"/, () => []],
    ]);
    const engine = new QueryEngine(counterSchema, dialect, driver);
    await engine.update("Counter", {
      where: { id: 1 },
      data: { views: { increment: 3 }, score: { set: 0 } },
    });
    const updateCall = driver.calls.find((c) => /UPDATE "COUNTER"/.test(c.sql))!;
    expect(updateCall.sql).toContain('"VIEWS" = "VIEWS" + ?');
    expect(updateCall.sql).toContain('"SCORE" = ?');
    expect(updateCall.params.slice(0, 2)).toEqual([3, 0]);
  });

  it("updateMany applies scalar/atomic updates and counts matched rows", async () => {
    const driver = new MockDriver([
      [/COUNT/, () => [{ _count: 4 }]],
      [/UPDATE "POST"/, () => []],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    const res = await engine.updateMany("Post", {
      where: { authorId: 1 },
      data: { title: { set: "x" } },
    });
    expect(res.count).toBe(4);
    expect(driver.calls.some((c) => /UPDATE "POST"/.test(c.sql))).toBe(true);
  });

  it("updateMany rejects nested relation writes", async () => {
    const driver = new MockDriver([[/COUNT/, () => [{ _count: 0 }]]]);
    const engine = new QueryEngine(doc, dialect, driver);
    await expect(
      engine.updateMany("Post", {
        where: {},
        data: { author: { connect: { id: 1 } } } as any,
      }),
    ).rejects.toThrow(/does not support nested relation writes/i);
  });

  it("rejects an atomic operator on a non-numeric field", async () => {
    const driver = new MockDriver([
      [/FROM "USERS"/, () => [{ id: 1, email: "a", name: "n" }]],
      [/UPDATE "USERS"/, () => []],
    ]);
    const engine = new QueryEngine(doc, dialect, driver);
    await expect(
      engine.update("User", {
        where: { id: 1 },
        data: { name: { increment: 1 } as any },
      }),
    ).rejects.toThrow(/only valid on numeric/i);
  });
});
