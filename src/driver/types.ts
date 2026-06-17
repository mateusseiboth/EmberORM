/**
 * Database driver abstraction. The query engine depends only on these
 * interfaces (DIP), never on `node-firebird` directly, so a different
 * backend could be plugged in without touching the engine.
 */

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  role?: string;
  encoding?: string;
  pageSize?: number;
  /** Max pooled connections. */
  poolMax?: number;
  blobAsText?: boolean;
  lowercaseKeys?: boolean;
  /**
   * Authentication plugin. Firebird 3+ defaults to "Srp" (secure remote
   * password) and is negotiated automatically; use "Legacy_Auth" for legacy
   * Firebird 2.1/2.5 servers.
   */
  authPlugin?: "Srp" | "Legacy_Auth";
  /** Enable wire compression (Firebird 3+). */
  wireCompression?: boolean;
  /**
   * Target server major version, used to pick version-specific SQL/DDL
   * (e.g. BOOLEAN vs SMALLINT, IDENTITY vs generator+trigger). Defaults to 3.
   */
  version?: FirebirdVersion;
}

export type FirebirdVersion = "2.1" | "2.5" | "3" | "4" | "5";

export type SqlValue =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Buffer
  | null;

/** A connection scoped to an open transaction. */
export interface TransactionContext {
  /** Run a parameterized query and return all rows. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
}

/** 1:1 with Prisma's `Prisma.TransactionIsolationLevel`. */
export type IsolationLevel =
  | "ReadUncommitted"
  | "ReadCommitted"
  | "RepeatableRead"
  | "Serializable";

/** Emitted once per executed statement when a logger is configured. */
export interface QueryEvent {
  sql: string;
  params: readonly SqlValue[];
  durationMs: number;
  /** Number of rows returned (selects) or affected-ish (best-effort). */
  rowCount: number;
}

export type QueryLogger = (event: QueryEvent) => void;

export interface DriverOptions {
  /** Called after each statement completes (used by the client `log` option). */
  onQuery?: QueryLogger;
}

/**
 * 1:1 with Prisma's interactive-transaction options. `maxWait`/`timeout` are
 * accepted for drop-in compatibility; Firebird honors `isolationLevel`.
 */
export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: IsolationLevel;
}

/**
 * The driver contract used by the runtime. Every read and write goes through
 * `transaction()` so the project rule "every operation runs in a transaction"
 * holds by construction.
 */
export interface SqlDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Run `fn` inside a transaction, committing on success and rolling back on
   * any thrown error. Nested calls reuse the active transaction.
   */
  transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
