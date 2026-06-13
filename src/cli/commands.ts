import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findSchemaPath,
  loadSchema,
  parseSchema,
  printSchema,
  resolveDatasourceUrl,
  validateSchema,
} from "@ember/schema";
import { createDriver } from "@ember/driver";
import { Introspector } from "@ember/introspect";
import { writeClient } from "@ember/generator";
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

/** `ember format` — re-print the schema with canonical formatting. */
export function format(ctx: CliContext, schemaPath?: string): number {
  const path = requireSchema(ctx, schemaPath);
  if (!path) return 1;
  const source = readFileSync(path, "utf8");
  const doc = parseSchema(source, path);
  validateSchema(doc);
  writeFileSync(path, printSchema(doc), "utf8");
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

/** `ember db push` is not yet implemented (no migration engine). */
export function notImplemented(ctx: CliContext, name: string): number {
  ctx.error(`Command '${name}' is not implemented yet.`);
  return 1;
}

// ---- helpers --------------------------------------------------------------

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
