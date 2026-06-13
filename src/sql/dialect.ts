import type { SqlValue } from "@ember/driver";
import { Sql } from "./fragment";

/**
 * Strategy interface for SQL generation. Encapsulates every dialect-specific
 * decision so the query compiler stays backend-agnostic. Only FirebirdDialect
 * is implemented today, but the engine never assumes Firebird directly.
 */
export interface SqlDialect {
  /** Quote an identifier (table/column/alias). */
  quoteId(name: string): string;
  /** Quote a `table.column` reference. */
  quoteRef(table: string, column: string): string;
  /** Pagination clause placed right after SELECT (e.g. `FIRST 10 SKIP 5`). */
  paginationClause(take?: number, skip?: number): string;
  /** Wrap a value for LIKE with case-insensitive mode. */
  caseInsensitive(expr: string): string;
  /** Map a default function name (now/uuid/...) to a SQL expression, if any. */
  defaultFunctionSql(name: string): string | null;
  /** Coerce a JS value into a driver-bindable SqlValue. */
  coerceValue(value: unknown): SqlValue;
  /** True if the dialect can paginate (controls FIRST/SKIP usage). */
  readonly supportsReturning: boolean;
}

/**
 * Firebird 3+/4+ dialect.
 * - Identifiers are double-quoted to preserve case (introspection yields
 *   UPPER-CASE names and quoting avoids accidental folding).
 * - Pagination uses `FIRST n SKIP m` after the SELECT keyword.
 * - Case-insensitive matching uses UPPER() on both sides.
 */
export class FirebirdDialect implements SqlDialect {
  readonly supportsReturning = true;

  quoteId(name: string): string {
    // Escape embedded double quotes by doubling them.
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteRef(table: string, column: string): string {
    return `${this.quoteId(table)}.${this.quoteId(column)}`;
  }

  paginationClause(take?: number, skip?: number): string {
    const parts: string[] = [];
    if (typeof take === "number" && take >= 0) {
      parts.push(`FIRST ${Math.trunc(take)}`);
    }
    if (typeof skip === "number" && skip > 0) {
      parts.push(`SKIP ${Math.trunc(skip)}`);
    }
    return parts.join(" ");
  }

  caseInsensitive(expr: string): string {
    return `UPPER(${expr})`;
  }

  defaultFunctionSql(name: string): string | null {
    switch (name) {
      case "now":
        return "CURRENT_TIMESTAMP";
      case "uuid":
      case "cuid":
        // Firebird can generate a 16-byte GUID; expose as a string-friendly UUID.
        return "UUID_TO_CHAR(GEN_UUID())";
      case "autoincrement":
        return null; // handled via generators/identity, not an inline default
      default:
        return null;
    }
  }

  coerceValue(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return value;
    if (typeof value === "string") return value;
    // Json / objects are serialized to text.
    return JSON.stringify(value);
  }
}

/** Helper to build `SELECT <pagination> ...` with the dialect's clause. */
export function selectKeyword(
  dialect: SqlDialect,
  take?: number,
  skip?: number,
): Sql {
  const pagination = dialect.paginationClause(take, skip);
  return Sql.raw(pagination ? `SELECT ${pagination}` : "SELECT");
}
