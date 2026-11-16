import { describe, expect, it, vi } from "vitest";

const destroyed: number[] = [];

vi.mock("node-firebird", () => {
  const tr = {
    query: (_sql: string, _params: unknown[], cb: (e: unknown, r: unknown) => void) =>
      cb(null, [{ _count: 1 }]),
    commit: (cb: (e: unknown) => void) => cb(null),
    rollback: (cb: (e: unknown) => void) => cb(null),
  };
  const db = {
    transaction: (_iso: unknown, cb: (e: unknown, t: unknown) => void) => cb(null, tr),
    detach: () => {},
  };
  const Firebird = {
    pool: () => ({
      get: (cb: (e: unknown, d: unknown) => void) => cb(null, db),
      destroy: () => destroyed.push(1),
    }),
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
  id Int @id
}`);

describe("client lifecycle", () => {
  it("$disconnect closes the pool opened lazily by the first query (no $connect call)", async () => {
    const db = createClient({ schema, datasourceUrl: "firebird://u:p@localhost:3050/db.fdb" });
    await (db as any).user.count();
    await db.$disconnect();
    expect(destroyed).toHaveLength(1);
  });
});
