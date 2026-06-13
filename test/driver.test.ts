import { describe, expect, it } from "vitest";
import { parseConnectionUrl, buildConnectionUrl } from "@ember/driver";
import { FirebirdDialect } from "@ember/sql";

describe("connection url", () => {
  it("parses a full firebird URL", () => {
    const cfg = parseConnectionUrl(
      "firebird://SYSDBA:masterkey@db.host:3050//var/lib/firebird/app.fdb?role=RDB$ADMIN&poolMax=10",
    );
    expect(cfg).toMatchObject({
      host: "db.host",
      port: 3050,
      user: "SYSDBA",
      password: "masterkey",
      database: "/var/lib/firebird/app.fdb",
      role: "RDB$ADMIN",
      poolMax: 10,
    });
  });

  it("applies defaults for host/port/user", () => {
    const cfg = parseConnectionUrl("firebird://localhost//tmp/x.fdb");
    expect(cfg.host).toBe("localhost");
    expect(cfg.port).toBe(3050);
    expect(cfg.user).toBe("SYSDBA");
    expect(cfg.database).toBe("/tmp/x.fdb");
  });

  it("round-trips through buildConnectionUrl", () => {
    const url = buildConnectionUrl({
      host: "h",
      port: 3050,
      user: "u",
      password: "p",
      database: "/d.fdb",
    });
    const cfg = parseConnectionUrl(url);
    expect(cfg.host).toBe("h");
    expect(cfg.user).toBe("u");
    expect(cfg.database).toBe("/d.fdb");
  });
});

describe("firebird dialect", () => {
  const d = new FirebirdDialect();
  it("quotes identifiers and escapes quotes", () => {
    expect(d.quoteId("USERS")).toBe('"USERS"');
    expect(d.quoteId('we"ird')).toBe('"we""ird"');
    expect(d.quoteRef("t0", "ID")).toBe('"t0"."ID"');
  });

  it("builds FIRST/SKIP pagination clauses", () => {
    expect(d.paginationClause(10, 5)).toBe("FIRST 10 SKIP 5");
    expect(d.paginationClause(10)).toBe("FIRST 10");
    expect(d.paginationClause(undefined, 5)).toBe("SKIP 5");
    expect(d.paginationClause()).toBe("");
  });

  it("coerces values for binding", () => {
    expect(d.coerceValue({ a: 1 })).toBe('{"a":1}');
    expect(d.coerceValue(null)).toBeNull();
    expect(d.coerceValue(5)).toBe(5);
  });
});
