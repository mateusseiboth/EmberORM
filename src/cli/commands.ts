import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  findSchemaPath,
  formatSchema,
  loadSchema,
  printSchema,
  resolveDatasourceUrl,
} from "@ember/schema";
import {
  createDriver,
  parseConnectionUrl,
  type SqlDriver,
} from "@ember/driver";
import { FirebirdDialect } from "@ember/sql";
import { Introspector } from "@ember/introspect";
import { writeClient } from "@ember/generator";
import { Migrator } from "@ember/migrate";
import { EmberClientBase } from "@ember/client";
import { startStudioServer } from "@ember/studio";
import { readFileSync } from "node:fs";

export interface CliContext {
  cwd: string;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const DEFAULT_SCHEMA = "ember/schema.ember";

const STARTER_SCHEMA = `datasource db {
  provider = "firebird"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "ember-client-js"
  output   = "../generated"
}

/// Example model — replace with your own or run \`ember db pull\`.
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
}
`;

/** `ember init` — scaffold a schema file. */
export function init(ctx: CliContext): number {
  const target = resolve(ctx.cwd, DEFAULT_SCHEMA);
  if (existsSync(target)) {
    ctx.error(`Schema already exists at ${target}`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, STARTER_SCHEMA, "utf8");
  ctx.log(`Created ${rel(ctx.cwd, target)}`);
  ctx.log("Set DATABASE_URL and run `ember db pull` or `ember generate`.");
  return 0;
}

/** `ember validate` — parse and validate the schema. */
export function validate(ctx: CliContext, schemaPath?: string): number {
  const path = requireSchema(ctx, schemaPath);
  if (!path) return 1;
  loadSchema(path);
  ctx.log(`Schema at ${rel(ctx.cwd, path)} is valid.`);
  return 0;
}

/**
 * `ember format` — auto-complete missing relation sides and re-print the schema
 * with canonical formatting (like Prisma's formatter).
 */
export function format(ctx: CliContext, schemaPath?: string): number {
  const path = requireSchema(ctx, schemaPath);
  if (!path) return 1;
  const source = readFileSync(path, "utf8");
  writeFileSync(path, formatSchema(source, path), "utf8");
  ctx.log(`Formatted ${rel(ctx.cwd, path)}`);
  return 0;
}

/** `ember generate` — emit the typed client from the schema. */
export function generate(ctx: CliContext, schemaPath?: string): number {
  const path = requireSchema(ctx, schemaPath);
  if (!path) return 1;
  const { document } = loadSchema(path);
  const gen = document.generators[0];
  const out = resolve(dirname(path), gen?.output ?? "../generated");
  const file = writeClient(document, out);
  ctx.log(`Generated client at ${rel(ctx.cwd, file)}`);
  return 0;
}

/** `ember db pull` — introspect the database and write the schema. */
export async function dbPull(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string },
): Promise<number> {
  const path =
    findSchemaPath(ctx.cwd, options.schemaPath) ??
    resolve(ctx.cwd, DEFAULT_SCHEMA);

  let url = options.url;
  let envVar = "DATABASE_URL";
  if (!url && existsSync(path)) {
    const { document } = loadSchema(path);
    url = resolveDatasourceUrl(document, dirname(path));
    if (document.datasource?.url.kind === "env") {
      envVar = document.datasource.url.value;
    }
  }
  url ??= process.env.DATABASE_URL;
  if (!url) {
    ctx.error(
      "No database URL. Set DATABASE_URL, pass --url, or add a datasource block.",
    );
    return 1;
  }

  const driver = createDriver(url);
  try {
    await driver.connect();
    const introspector = new Introspector(driver);
    const document = await introspector.introspect({
      datasource: { name: "db", provider: "firebird", envVar },
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, printSchema(document), "utf8");
    ctx.log(
      `Introspected ${document.models.length} model(s) into ${rel(ctx.cwd, path)}`,
    );
    return 0;
  } finally {
    await driver.disconnect();
  }
}

/** `ember migrate dev [--name x]` — diff, write a migration file, apply it. */
export async function migrateDev(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string; name?: string },
): Promise<number> {
  return withMigrator(ctx, options, async (migrator) => {
    const result = await migrator.dev(options.name ?? "migration");
    if (result.empty) {
      ctx.log("No schema changes — database already in sync.");
      return 0;
    }
    ctx.log(`Created and applied migration ${result.id} (${result.statements.length} step(s)).`);
    return 0;
  });
}

/** `ember migrate deploy` — apply all pending migration files. */
export async function migrateDeploy(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string },
): Promise<number> {
  return withMigrator(ctx, options, async (migrator) => {
    const { applied } = await migrator.deploy();
    if (applied.length === 0) {
      ctx.log("No pending migrations.");
      return 0;
    }
    for (const m of applied) ctx.log(`Applied ${m.id} (${m.steps} step(s)).`);
    return 0;
  });
}

/** `ember migrate status` — show applied vs pending migrations. */
export async function migrateStatus(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string },
): Promise<number> {
  return withMigrator(ctx, options, async (migrator) => {
    const { applied, pending } = await migrator.status();
    ctx.log(`Applied (${applied.length}):`);
    for (const id of applied) ctx.log(`  ✓ ${id}`);
    ctx.log(`Pending (${pending.length}):`);
    for (const id of pending) ctx.log(`  • ${id}`);
    return 0;
  });
}

/** `ember db push` — apply the diff directly without creating a migration. */
export async function dbPush(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string },
): Promise<number> {
  return withMigrator(ctx, options, async (migrator) => {
    const { statements } = await migrator.push();
    if (statements.length === 0) {
      ctx.log("No schema changes — database already in sync.");
      return 0;
    }
    ctx.log(`Applied ${statements.length} statement(s) to the database.`);
    return 0;
  });
}

/** `ember studio` — launch the local web GUI (EmberStudio). */
export async function studio(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string; port?: number; open?: boolean },
): Promise<number> {
  const path = requireSchema(ctx, options.schemaPath);
  if (!path) return 1;
  const { document } = loadSchema(path);

  const url =
    options.url ??
    resolveDatasourceUrl(document, dirname(path)) ??
    process.env.DATABASE_URL;
  if (!url) {
    ctx.error(
      "No database URL. Set DATABASE_URL, pass --url, or add a datasource block.",
    );
    return 1;
  }

  const client = new EmberClientBase({ schema: document, datasourceUrl: url });
  await client.$connect();

  let server: Awaited<ReturnType<typeof startStudioServer>>;
  try {
    server = await startStudioServer({
      client,
      schema: document,
      port: options.port,
    });
  } catch (err) {
    await client.$disconnect();
    const message = err instanceof Error ? err.message : String(err);
    ctx.error(`Could not start EmberStudio: ${message}`);
    return 1;
  }

  ctx.log(`EmberStudio running at ${server.url}`);
  ctx.log("This is a local-only tool with no authentication. Press Ctrl+C to stop.");

  if (options.open) openBrowser(server.url);

  // Keep the process alive until interrupted, then clean up.
  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      void (async () => {
        await server.close().catch(() => {});
        await client.$disconnect().catch(() => {});
        resolve(0);
      })();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// ---- helpers --------------------------------------------------------------

/** Resolve schema + URL, open a driver, build a Migrator, and run `fn`. */
async function withMigrator(
  ctx: CliContext,
  options: { schemaPath?: string; url?: string },
  fn: (migrator: Migrator) => Promise<number>,
): Promise<number> {
  const path = requireSchema(ctx, options.schemaPath);
  if (!path) return 1;
  const { document } = loadSchema(path);

  const url =
    options.url ??
    resolveDatasourceUrl(document, dirname(path)) ??
    process.env.DATABASE_URL;
  if (!url) {
    ctx.error(
      "No database URL. Set DATABASE_URL, pass --url, or add a datasource block.",
    );
    return 1;
  }

  const migrationsDir = resolve(dirname(path), "migrations");
  const config = parseConnectionUrl(url);
  const dialect = new FirebirdDialect({ version: config.version });
  const driver: SqlDriver = createDriver(config);
  try {
    await driver.connect();
    const migrator = new Migrator(driver, document, migrationsDir, dialect);
    return await fn(migrator);
  } finally {
    await driver.disconnect();
  }
}

/** Best-effort: open the default browser at `url`. Failures are ignored. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser available (CI/headless) — the URL is already logged.
  }
}

function requireSchema(ctx: CliContext, schemaPath?: string): string | null {
  const path = findSchemaPath(ctx.cwd, schemaPath);
  if (!path) {
    ctx.error(
      `Schema not found. Expected ${DEFAULT_SCHEMA} (or pass --schema). Run \`ember init\` to create one.`,
    );
    return null;
  }
  return path;
}

function rel(cwd: string, target: string): string {
  return target.startsWith(cwd) ? target.slice(cwd.length + 1) : target;
}
