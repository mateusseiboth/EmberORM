import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, parseEnv } from "@ember/utils";

describe("parseEnv", () => {
  it("parses plain, quoted and exported assignments", () => {
    const env = parseEnv(
      [
        "# a comment",
        "PLAIN=value",
        'DOUBLE="quoted value"',
        "SINGLE='raw value'",
        "export EXPORTED=fromExport",
        "WITH_COMMENT=keep # dropped",
        "EMPTY=",
      ].join("\n"),
    );
    expect(env.PLAIN).toBe("value");
    expect(env.DOUBLE).toBe("quoted value");
    expect(env.SINGLE).toBe("raw value");
    expect(env.EXPORTED).toBe("fromExport");
    expect(env.WITH_COMMENT).toBe("keep");
    expect(env.EMPTY).toBe("");
  });

  it("keeps '#' and '=' inside quoted values (e.g. Firebird URLs)", () => {
    const env = parseEnv(
      'DATABASE_URL="firebird://SYSDBA:p#a=s@10.0.0.1:3050/ALIAS?auth=legacy"',
    );
    expect(env.DATABASE_URL).toBe(
      "firebird://SYSDBA:p#a=s@10.0.0.1:3050/ALIAS?auth=legacy",
    );
  });
});

describe("loadEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("loads .env from a directory without overwriting existing vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "ember-env-"));
    writeFileSync(
      join(dir, ".env"),
      "EMBER_NEW=loaded\nEMBER_EXISTING=fromFile\n",
      "utf8",
    );
    process.env.EMBER_EXISTING = "fromProcess";

    const loaded = loadEnv(dir);
    expect(loaded).toBe(join(dir, ".env"));
    expect(process.env.EMBER_NEW).toBe("loaded");
    expect(process.env.EMBER_EXISTING).toBe("fromProcess");
  });

  it("returns undefined when no .env exists up to the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ember-env-empty-"));
    expect(loadEnv(dir)).toBeUndefined();
  });
});
