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
}

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

export type IsolationLevel =
  | "READ_COMMITTED"
  | "READ_COMMITTED_READ_ONLY"
  | "REPEATABLE_READ"
  | "SERIALIZABLE";

export interface TransactionOptions {
  isolation?: IsolationLevel;
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
