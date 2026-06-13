/**
 * Minimal ambient declarations for `node-firebird`.
 * The package ships no types and `@types/node-firebird` is not published, so
 * EmberORM declares only the slice of the callback API it actually uses.
 */
declare module "node-firebird" {
  export interface Options {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    role?: string;
    pageSize?: number;
    encoding?: string;
    blobAsText?: boolean;
    lowercase_keys?: boolean;
    retryConnectionInterval?: number;
  }

  export interface Transaction {
    query(
      sql: string,
      params: unknown[],
      cb: (err: unknown, result: unknown) => void,
    ): void;
    commit(cb: (err: unknown) => void): void;
    rollback(cb: (err: unknown) => void): void;
  }

  export interface Database {
    query(
      sql: string,
      params: unknown[],
      cb: (err: unknown, result: unknown) => void,
    ): void;
    transaction(
      isolation: unknown,
      cb: (err: unknown, tr: Transaction) => void,
    ): void;
    detach(cb?: (err: unknown) => void): void;
  }

  export interface ConnectionPool {
    get(cb: (err: unknown, db: Database) => void): void;
    destroy(): void;
  }

  export const ISOLATION_READ_COMMITTED: unknown;
  export const ISOLATION_READ_COMMITTED_READ_ONLY: unknown;
  export const ISOLATION_REPEATABLE_READ: unknown;
  export const ISOLATION_SERIALIZABLE: unknown;
  export const ISOLATION_READ_UNCOMMITTED: unknown;

  export function attach(
    options: Options,
    cb: (err: unknown, db: Database) => void,
  ): void;
  export function pool(
    max: number,
    options: Options,
    cb?: unknown,
  ): ConnectionPool;

  const Firebird: {
    attach: typeof attach;
    pool: typeof pool;
    ISOLATION_READ_COMMITTED: unknown;
    ISOLATION_READ_COMMITTED_READ_ONLY: unknown;
    ISOLATION_REPEATABLE_READ: unknown;
    ISOLATION_SERIALIZABLE: unknown;
    ISOLATION_READ_UNCOMMITTED: unknown;
  };
  export default Firebird;
}
