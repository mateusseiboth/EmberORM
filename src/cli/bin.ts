#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmberError } from "@ember/errors";
import {
  type CliContext,
  dbPull,
  dbPush,
  format,
  generate,
  init,
  migrateDeploy,
  migrateDev,
  migrateStatus,
  validate,
} from "./commands";

const HELP = `EmberORM — Prisma-like ORM for Firebird

Usage: ember <command> [options]

Commands:
  init                 Scaffold ember/schema.ember
  db pull              Introspect the database into your schema
  db push              Apply schema changes directly (no migration file)
  generate             Generate the typed client from the schema
  migrate dev          Diff, create a migration file, and apply it
  migrate deploy       Apply all pending migration files
  migrate status       Show applied vs pending migrations
  format               Re-print the schema with canonical formatting
  validate             Parse and validate the schema

Options:
  --schema <path>      Path to the schema file
  --url <url>          Firebird connection URL (overrides datasource/env)
  --name <name>        Migration name (migrate dev)
  -h, --help           Show this help
  -v, --version        Show version
`;

interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === "-h") {
      flags.help = true;
    } else if (arg === "-v") {
      flags.version = true;
    } else {
      command.push(arg);
    }
  }
  return { command, flags };
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const ctx: CliContext = {
    cwd: process.cwd(),
    log: (m) => process.stdout.write(m + "\n"),
    error: (m) => process.stderr.write(`error: ${m}\n`),
  };

  if (flags.version) {
    ctx.log(readVersion());
    return 0;
  }
  if (flags.help || command.length === 0) {
    ctx.log(HELP);
    return command.length === 0 ? 1 : 0;
  }

  const schemaPath = typeof flags.schema === "string" ? flags.schema : undefined;
  const url = typeof flags.url === "string" ? flags.url : undefined;
  const name = typeof flags.name === "string" ? flags.name : undefined;
  const [first, second] = command;

  switch (first) {
    case "init":
      return init(ctx);
    case "validate":
      return validate(ctx, schemaPath);
    case "format":
      return format(ctx, schemaPath);
    case "generate":
      return generate(ctx, schemaPath);
    case "db":
      if (second === "pull") return dbPull(ctx, { schemaPath, url });
      if (second === "push") return dbPush(ctx, { schemaPath, url });
      ctx.error(`Unknown db subcommand '${second ?? ""}'.`);
      return 1;
    case "migrate":
      if (second === "dev") return migrateDev(ctx, { schemaPath, url, name });
      if (second === "deploy") return migrateDeploy(ctx, { schemaPath, url });
      if (second === "status") return migrateStatus(ctx, { schemaPath, url });
      ctx.error(`Unknown migrate subcommand '${second ?? ""}'.`);
      return 1;
    default:
      ctx.error(`Unknown command '${first}'. Run 'ember --help'.`);
      return 1;
  }
}

function readVersion(): string {
  // dist/cli/bin.js -> ../../package.json
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const url = new URL(candidate, import.meta.url);
      const pkg = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
      if (pkg?.version) return `ember ${pkg.version}`;
    } catch {
      // try next candidate
    }
  }
  return "ember (unknown version)";
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof EmberError) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`unexpected error: ${(err as Error).stack ?? err}\n`);
    }
    process.exit(1);
  });
