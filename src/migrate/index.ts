import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SchemaDocument, modelTable } from "@ember/ast";
import type { SqlDriver, TransactionContext } from "@ember/driver";
import { EmberError } from "@ember/errors";
import { FirebirdDialect, type SqlDialect } from "@ember/sql";
import { Introspector } from "@ember/introspect";
import { diffSchemas, type SchemaDiff } from "./diff";
import { planMigration, renderMigrationSql, splitStatements } from "./planner";
import {
  HISTORY_TABLE,
  appliedMigrations,
  checksum,
  ensureHistoryTable,
  listLocalMigrations,
  recordMigration,
} from "./history";

export { diffSchemas } from "./diff";
export { planMigration, renderMigrationSql, splitStatements } from "./planner";
export { FirebirdDdl } from "./ddl";
export {
  HISTORY_TABLE,
  listLocalMigrations,
  appliedMigrations,
  ensureHistoryTable,
} from "./history";

export interface MigratorOptions {
  /**
   * Called with each generated SQL statement right before it runs. Wired to the
   * CLI `--log` flag so users can see exactly what DDL is being executed.
   */
  log?: (message: string) => void;
}

export interface DevResult {
  empty: boolean;
  id?: string;
  dir?: string;
  statements: string[];
}

export interface DeployResult {
  applied: { id: string; steps: number }[];
}

export interface StatusResult {
  applied: string[];
  pending: string[];
}

/**
 * Drives schema migrations against a live Firebird database. Diffs the desired
 * `.ember` schema against the introspected current state and emits/applies DDL.
 * The history table `_EMBER_MIGRATIONS` is always excluded from the diff.
 */
export class Migrator {
  private readonly dialect: SqlDialect;
  private readonly log?: (message: string) => void;

  constructor(
    private readonly driver: SqlDriver,
    private readonly desired: SchemaDocument,
    private readonly migrationsDir: string,
    dialect?: SqlDialect,
    options: MigratorOptions = {},
  ) {
    this.dialect = dialect ?? new FirebirdDialect();
    this.log = options.log;
  }

  /**
   * Run each statement in order, logging it first (when `--log` is set) and
   * wrapping any failure with the offending step so it's clear which statement
   * broke rather than just surfacing an opaque driver error.
   */
  private async apply(
    tx: TransactionContext,
    statements: string[],
  ): Promise<void> {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      this.log?.(`-- step ${i + 1}/${statements.length}\n${stmt};`);
      try {
        await tx.query(stmt);
      } catch (err) {
        throw new EmberError(
          `Migration step ${i + 1}/${statements.length} failed:\n` +
            `${stmt}\n\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Compute the diff between the desired schema and the live database. */
  async diff(): Promise<SchemaDiff> {
    const current = await this.currentSchema();
    return diffSchemas(this.desired, current);
  }

  /** Plan (but do not apply) the DDL needed to reach the desired schema. */
  async plan(): Promise<string[]> {
    const diff = await this.diff();
    return planMigration(diff, this.desired, this.dialect);
  }

  /**
   * `migrate dev`: create a timestamped migration from the current diff, apply
   * it, and record it in history.
   */
  async dev(name = "migration"): Promise<DevResult> {
    const statements = await this.plan();
    if (statements.length === 0) return { empty: true, statements: [] };

    const id = `${timestamp()}_${slug(name)}`;
    const dir = join(this.migrationsDir, id);
    const body = renderMigrationSql(statements);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "migration.sql"), body, "utf8");

    await this.driver.transaction(async (tx) => {
      await ensureHistoryTable(tx, this.dialect);
      await this.apply(tx, statements);
      await recordMigration(tx, this.dialect, {
        id,
        checksum: checksum(body),
        steps: statements.length,
      });
    });

    return { empty: false, id, dir, statements };
  }

  /**
   * `db push`: apply the diff directly to the database without writing a
   * migration file (prototyping flow).
   */
  async push(): Promise<{ statements: string[] }> {
    const statements = await this.plan();
    if (statements.length === 0) return { statements: [] };
    await this.driver.transaction(async (tx) => {
      await this.apply(tx, statements);
    });
    return { statements };
  }

  /** `migrate deploy`: apply every on-disk migration not yet recorded. */
  async deploy(): Promise<DeployResult> {
    const local = listLocalMigrations(this.migrationsDir);
    const applied: { id: string; steps: number }[] = [];

    const known = await this.driver.transaction(async (tx) => {
      await ensureHistoryTable(tx, this.dialect);
      return new Set((await appliedMigrations(tx, this.dialect)).map((m) => m.id));
    });

    for (const migration of local) {
      if (known.has(migration.id)) continue;
      const statements = splitStatements(migration.sql);
      await this.driver.transaction(async (tx) => {
        await this.apply(tx, statements);
        await recordMigration(tx, this.dialect, {
          id: migration.id,
          checksum: checksum(migration.sql),
          steps: statements.length,
        });
      });
      applied.push({ id: migration.id, steps: statements.length });
    }
    return { applied };
  }

  /** `migrate status`: list applied vs pending migrations. */
  async status(): Promise<StatusResult> {
    const local = listLocalMigrations(this.migrationsDir).map((m) => m.id);
    const applied = await this.driver.transaction(async (tx) => {
      await ensureHistoryTable(tx, this.dialect);
      return (await appliedMigrations(tx, this.dialect)).map((m) => m.id);
    });
    const appliedSet = new Set(applied);
    return {
      applied,
      pending: local.filter((id) => !appliedSet.has(id)),
    };
  }

  private async currentSchema(): Promise<SchemaDocument> {
    const introspector = new Introspector(this.driver);
    const current = await introspector.introspect();
    // Never diff the migration bookkeeping table.
    current.models = current.models.filter(
      (m) => modelTable(m) !== HISTORY_TABLE,
    );
    return current;
  }
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "migration";
}
