import { type SqlDialect } from "@ember/sql";
import { type SchemaDocument, modelTable } from "@ember/ast";
import { FirebirdDdl } from "./ddl";
import {
  type SchemaDiff,
  constraintName,
  foreignKeys,
  indexSpecs,
  uniqueColumnSets,
} from "./diff";

/**
 * Convert a SchemaDiff into an ordered list of DDL statements. Order matters in
 * Firebird: tables and columns must exist before constraints reference them, so
 * foreign keys are always emitted last.
 */
export function planMigration(
  diff: SchemaDiff,
  desired: SchemaDocument,
  dialect: SqlDialect,
): string[] {
  const ddl = new FirebirdDdl(dialect);
  const drops: string[] = [];
  const creates: string[] = [];
  const alters: string[] = [];
  const constraints: string[] = [];
  const indexes: string[] = [];
  const foreignKeyStmts: string[] = [];

  // 1. Drops (columns then tables).
  for (const change of diff.modelChanges) {
    for (const col of change.droppedColumns) {
      drops.push(ddl.dropColumn(change.table, col));
    }
  }
  for (const table of diff.droppedTables) {
    drops.push(ddl.dropTable(table));
  }

  // 2. Create tables (no FKs yet) + their uniques/indexes/FKs.
  for (const model of diff.createdModels) {
    const table = modelTable(model);
    creates.push(ddl.createTable(model));
    for (const cols of uniqueColumnSets(model)) {
      // Single-column @unique already implies a unique index; skip to avoid
      // a redundant constraint. Composite @@unique becomes a constraint.
      if (cols.length === 1) continue;
      constraints.push(
        ddl.addUnique(table, constraintName("UQ", table, cols), cols),
      );
    }
    for (const idx of indexSpecs(model)) {
      indexes.push(ddl.createIndex(table, idx.name, idx.columns, idx.unique));
    }
    for (const fk of foreignKeys(desired, model)) {
      foreignKeyStmts.push(
        ddl.addForeignKey(
          table,
          constraintName("FK", table, fk.columns),
          fk.columns,
          fk.refTable,
          fk.refColumns,
          fk.onDelete,
          fk.onUpdate,
        ),
      );
    }
  }

  // 3. Existing-table changes.
  for (const change of diff.modelChanges) {
    for (const field of change.addedColumns) {
      alters.push(ddl.addColumn(change.table, field));
    }
    for (const cc of change.changedColumns) {
      if (cc.typeChanged) alters.push(ddl.alterColumnType(cc.table, cc.field));
      if (cc.nullabilityChanged) {
        alters.push(
          ddl.setNotNull(cc.table, columnName(cc), cc.field.isRequired),
        );
      }
    }
    for (const uq of change.addedUniques) {
      if (uq.columns.length === 1) {
        // single-column unique: a constraint is fine and idempotent-checked
        constraints.push(ddl.addUnique(change.table, uq.name, uq.columns));
      } else {
        constraints.push(ddl.addUnique(change.table, uq.name, uq.columns));
      }
    }
    for (const fk of change.addedForeignKeys) {
      foreignKeyStmts.push(
        ddl.addForeignKey(
          change.table,
          fk.name,
          fk.columns,
          fk.refTable,
          fk.refColumns,
          fk.onDelete,
          fk.onUpdate,
        ),
      );
    }
  }

  return [
    ...drops,
    ...creates,
    ...alters,
    ...constraints,
    ...indexes,
    ...foreignKeyStmts,
  ];
}

/** Render DDL statements as a `.sql` migration file body. */
export function renderMigrationSql(statements: string[]): string {
  if (statements.length === 0) return "-- This migration is empty.\n";
  return statements.map((s) => `${s};`).join("\n\n") + "\n";
}

/** Split a migration `.sql` body back into executable statements. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => stripComments(s).trim())
    .filter((s) => s.length > 0);
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function columnName(cc: { field: { dbName?: string; name: string } }): string {
  return cc.field.dbName ?? cc.field.name.toUpperCase();
}
