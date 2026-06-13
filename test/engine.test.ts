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
});
