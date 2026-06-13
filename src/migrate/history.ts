import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TransactionContext } from "@ember/driver";
import { type SqlDialect } from "@ember/sql";

export const HISTORY_TABLE = "_EMBER_MIGRATIONS";

export interface AppliedMigration {
  id: string;
  checksum: string;
  steps: number;
}

export interface LocalMigration {
  id: string;
  dir: string;
  sql: string;
}

/** Create the migration-history table if it does not exist yet. */
export async function ensureHistoryTable(
  tx: TransactionContext,
  dialect: SqlDialect,
): Promise<void> {
  const exists = await tx.query<{ N: number }>(
    `SELECT COUNT(*) AS N FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ?`,
    [HISTORY_TABLE],
  );
  if (Number(exists[0]?.N ?? 0) > 0) return;

  const t = dialect.quoteId(HISTORY_TABLE);
  await tx.query(
    `CREATE TABLE ${t} (
       ${dialect.quoteId("ID")} VARCHAR(128) NOT NULL PRIMARY KEY,
       ${dialect.quoteId("CHECKSUM")} VARCHAR(64),
       ${dialect.quoteId("STEPS")} INTEGER,
       ${dialect.quoteId("APPLIED_AT")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  );
}

export async function appliedMigrations(
  tx: TransactionContext,
  dialect: SqlDialect,
): Promise<AppliedMigration[]> {
  const t = dialect.quoteId(HISTORY_TABLE);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT ${dialect.quoteId("ID")} AS "id", ${dialect.quoteId("CHECKSUM")} AS "checksum", ${dialect.quoteId("STEPS")} AS "steps" FROM ${t} ORDER BY ${dialect.quoteId("ID")}`,
  );
  return rows.map((r) => ({
    id: String(r.id).trim(),
    checksum: r.checksum == null ? "" : String(r.checksum).trim(),
    steps: Number(r.steps ?? 0),
  }));
}

export async function recordMigration(
  tx: TransactionContext,
  dialect: SqlDialect,
  migration: { id: string; checksum: string; steps: number },
): Promise<void> {
  const t = dialect.quoteId(HISTORY_TABLE);
  await tx.query(
    `INSERT INTO ${t} (${dialect.quoteId("ID")}, ${dialect.quoteId("CHECKSUM")}, ${dialect.quoteId("STEPS")}) VALUES (?, ?, ?)`,
    [migration.id, migration.checksum, migration.steps],
  );
}

/** Read migration folders (sorted) from `<migrationsDir>`. */
export function listLocalMigrations(migrationsDir: string): LocalMigration[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const dir = join(migrationsDir, id);
      const file = join(dir, "migration.sql");
      return {
        id,
        dir,
        sql: existsSync(file) ? readFileSync(file, "utf8") : "",
      };
    })
    .filter((m) => m.sql.length > 0);
}

/** FNV-1a checksum of a migration body. */
export function checksum(sql: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
