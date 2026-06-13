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

  it("parses auth plugin, wire compression and version", () => {
    const cfg = parseConnectionUrl(
      "firebird://SYSDBA:masterkey@h:3050//db.fdb?auth=legacy&wireCompression=true&version=2.5",
    );
    expect(cfg.authPlugin).toBe("Legacy_Auth");
    expect(cfg.wireCompression).toBe(true);
    expect(cfg.version).toBe("2.5");

    const srp = parseConnectionUrl("firebird://u:p@h//db.fdb?authPlugin=srp&version=4.0");
    expect(srp.authPlugin).toBe("Srp");
    expect(srp.version).toBe("4");
  });
});

describe("firebird dialect versions", () => {
  it("uses BOOLEAN and IDENTITY on Firebird 3+", () => {
    const d = new FirebirdDialect({ version: "3" });
    expect(d.supportsBooleanType).toBe(true);
    expect(d.supportsIdentity).toBe(true);
    expect(d.booleanColumnType()).toBe("BOOLEAN");
    expect(d.coerceValue(true)).toBe(true);
  });

  it("falls back to SMALLINT 0/1 and generators on Firebird 2.1", () => {
    const d = new FirebirdDialect({ version: "2.1" });
    expect(d.supportsBooleanType).toBe(false);
    expect(d.supportsIdentity).toBe(false);
    expect(d.booleanColumnType()).toBe("SMALLINT");
    expect(d.coerceValue(true)).toBe(1);
    expect(d.coerceValue(false)).toBe(0);
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
