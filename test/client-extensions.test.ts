import { describe, expect, it, vi, beforeEach } from "vitest";

// Controllable query handler shared with the mocked driver.
type Handler = (sql: string, params: unknown[]) => unknown[];
const state: { handler: Handler; calls: { sql: string; params: unknown[] }[] } = {
  handler: () => [],
  calls: [],
};
(globalThis as any).__ember = state;

vi.mock("node-firebird", () => {
  const tr = {
    query: (sql: string, params: unknown[], cb: (e: unknown, r: unknown) => void) => {
      const s = (globalThis as any).__ember as typeof state;
      s.calls.push({ sql, params });
      cb(null, s.handler(sql, params));
    },
    commit: (cb: (e: unknown) => void) => cb(null),
    rollback: (cb: (e: unknown) => void) => cb(null),
  };
  const db = {
    transaction: (_iso: unknown, cb: (e: unknown, t: unknown) => void) => cb(null, tr),
    detach: () => {},
  };
  const pool = {
    get: (cb: (e: unknown, d: unknown) => void) => cb(null, db),
    destroy: () => {},
  };
  const Firebird = {
    pool: () => pool,
    attach: () => {},
    ISOLATION_READ_COMMITTED: 1,
    ISOLATION_READ_COMMITTED_READ_ONLY: 2,
    ISOLATION_REPEATABLE_READ: 3,
    ISOLATION_SERIALIZABLE: 4,
  };
  return { default: Firebird, ...Firebird };
});

const { createClient } = await import("@ember/client");
const { parseSchema } = await import("@ember/schema");

const schema = parseSchema(`model User {
  id        Int     @id @default(autoincrement())
  email     String  @unique
  firstName String?
  lastName  String?
  posts     Post[]
  @@map("USERS")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("AUTHOR_ID")
  author   User   @relation(fields: [authorId], references: [id])
}`);

function client() {
  return createClient({
    schema,
    datasourceUrl: "firebird://u:p@h:3050//d.fdb",
  }) as any;
}

beforeEach(() => {
  state.handler = () => [];
  state.calls = [];
});

describe("client extensions ($extends)", () => {
  it("result: adds a computed field to query results", async () => {
    state.handler = () => [{ id: 1, email: "a@x.com", firstName: "Ada", lastName: "L" }];
    const db = client().$extends({
      result: {
        User: {
          fullName: {
            needs: { firstName: true, lastName: true },
            compute: (u: any) => `${u.firstName} ${u.lastName}`,
          },
        },
      },
    });
    const user = await db.user.findFirst();
    expect(user.fullName).toBe("Ada L");
  });

  it("model: adds a custom method to a delegate", async () => {
    state.handler = () => [{ id: 7, email: "a@x.com" }];
    const db = client().$extends({
      model: {
        User: {
          async findByEmail(this: any, email: string) {
            return this.findFirst({ where: { email } });
          },
        },
      },
    });
    const user = await db.user.findByEmail("a@x.com");
    expect(user.id).toBe(7);
  });

  it("query: intercepts and rewrites operation args", async () => {
    state.handler = () => [{ id: 1, email: "a@x.com" }];
    let seen: any = null;
    const db = client().$extends({
      query: {
        User: {
          findMany: ({ args, query }: any) => {
            seen = args;
            return query({ ...args, take: 1 });
          },
        },
      },
    });
    await db.user.findMany({ where: { email: "a@x.com" } });
    expect(seen).toEqual({ where: { email: "a@x.com" } });
    // the rewritten take=1 reached SQL (FIRST 1)
    expect(state.calls.some((c) => /FIRST 1/.test(c.sql))).toBe(true);
  });

  it("client: adds a top-level method", async () => {
    const db = client().$extends({
      client: { $hello: () => "hi" },
    });
    expect(db.$hello()).toBe("hi");
  });

  it("does not mutate the original client", async () => {
    const base = client();
    const extended = base.$extends({ client: { $x: () => 1 } });
    expect((extended as any).$x()).toBe(1);
    expect((base as any).$x).toBeUndefined();
  });
});

describe("middleware ($use) and events ($on)", () => {
  it("$use wraps operations", async () => {
    state.handler = () => [{ id: 1, email: "a@x.com" }];
    const db = client();
    const order: string[] = [];
    db.$use(async (params: any, next: any) => {
      order.push(`before:${params.action}`);
      const r = await next(params);
      order.push("after");
      return r;
    });
    await db.user.findFirst();
    expect(order).toEqual(["before:findFirst", "after"]);
  });

  it("$on('query') receives query events", async () => {
    state.handler = () => [{ id: 1, email: "a@x.com" }];
    const db = client();
    const events: any[] = [];
    db.$on("query", (e: any) => events.push(e));
    await db.user.findFirst();
    expect(events.length).toBeGreaterThan(0);
    expect(typeof events[0].sql).toBe("string");
  });
});

describe("fluent API", () => {
  it("traverses a to-many relation from a unique read", async () => {
    state.handler = (sql) =>
      /FROM "POST"/.test(sql)
        ? [
            { id: 10, title: "P1", authorId: 1 },
            { id: 11, title: "P2", authorId: 1 },
          ]
        : [{ id: 1, email: "a@x.com" }];
    const db = client();
    const posts = await db.user.findUnique({ where: { id: 1 } }).posts();
    expect(posts.map((p: any) => p.id)).toEqual([10, 11]);
    // the posts query filtered through the author relation (EXISTS subquery)
    const postCall = state.calls.find((c) => /FROM "POST"/.test(c.sql))!;
    expect(postCall.sql).toContain("EXISTS");
  });

  it("awaiting the fluent result returns the record itself", async () => {
    state.handler = () => [{ id: 1, email: "a@x.com" }];
    const db = client();
    const user = await db.user.findUnique({ where: { id: 1 } });
    expect(user.id).toBe(1);
  });
});
