import { describe, expect, it, vi } from "vitest";

// Mock node-firebird so FirebirdDriver runs without a real database. The fake
// pool/transaction immediately invoke their callbacks with canned results.
vi.mock("node-firebird", () => {
  const tr = {
    query: (_sql: string, _params: unknown[], cb: (e: unknown, r: unknown) => void) =>
      cb(null, [{ N: 1 }]),
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

const { FirebirdDriver } = await import("@ember/driver");

describe("driver query logging", () => {
  it("invokes onQuery with sql, params, duration and rowCount", async () => {
    const events: any[] = [];
    const driver = new FirebirdDriver(
      { host: "h", port: 3050, database: "/d.fdb", user: "u", password: "p" },
      { onQuery: (e) => events.push(e) },
    );
    await driver.connect();
    const rows = await driver.transaction((tx) =>
      tx.query("SELECT 1 FROM RDB$DATABASE", [42]),
    );
    await driver.disconnect();

    expect(rows).toEqual([{ N: 1 }]);
    expect(events).toHaveLength(1);
    expect(events[0].sql).toContain("SELECT 1");
    expect(events[0].params).toEqual([42]);
    expect(events[0].rowCount).toBe(1);
    expect(typeof events[0].durationMs).toBe("number");
  });

  it("does not log when no onQuery hook is set", async () => {
    const driver = new FirebirdDriver({
      host: "h",
      port: 3050,
      database: "/d.fdb",
      user: "u",
      password: "p",
    });
    await driver.connect();
    const rows = await driver.transaction((tx) => tx.query("SELECT 1"));
    expect(rows).toEqual([{ N: 1 }]);
  });
});
