/**
 * Minimal, dependency-free `.env` loader.
 *
 * Node (unlike Bun) does not read `.env` automatically, so the CLI must load it
 * before commands resolve `env("DATABASE_URL")`. Existing `process.env` values
 * always win — a real environment variable overrides the file, matching how
 * dotenv and Prisma behave.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

/** Parse the contents of a `.env` file into key/value pairs. */
export function parseEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
      // Only double quotes expand escape sequences (dotenv convention).
      if (quoted[1] === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      // Strip trailing inline comments on unquoted values.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` from `startDir`, walking up to the filesystem root until one is
 * found. Variables already present in `process.env` are left untouched.
 * Returns the path that was loaded, or `undefined` if none exists.
 */
export function loadEnv(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  const root = parsePath(dir).root;
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const parsed = parseEnv(readFileSync(candidate, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return candidate;
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}
