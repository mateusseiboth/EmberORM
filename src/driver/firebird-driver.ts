import { AsyncLocalStorage } from "node:async_hooks";
import Firebird from "node-firebird";
import { DatabaseError } from "@ember/errors";
import type {
  ConnectionConfig,
  DriverOptions,
  IsolationLevel,
  SqlDriver,
  SqlValue,
  TransactionContext,
  TransactionOptions,
} from "./types";

// node-firebird is callback-based and weakly typed; these aliases keep the
// rest of the file readable without leaking `any` outward.
type FbDatabase = {
  query(sql: string, params: unknown[], cb: (err: unknown, result: unknown) => void): void;
  transaction(isolation: unknown, cb: (err: unknown, tr: FbTransaction) => void): void;
  detach(cb?: (err: unknown) => void): void;
};
type FbTransaction = {
  query(sql: string, params: unknown[], cb: (err: unknown, result: unknown) => void): void;
  commit(cb: (err: unknown) => void): void;
  rollback(cb: (err: unknown) => void): void;
};
type FbPool = {
  get(cb: (err: unknown, db: FbDatabase) => void): void;
  destroy(): void;
};

const fb = Firebird as unknown as {
  pool(max: number, options: unknown, cb?: unknown): FbPool;
  ISOLATION_READ_COMMITTED: unknown;
  ISOLATION_READ_COMMITTED_READ_ONLY: unknown;
  ISOLATION_REPEATABLE_READ: unknown;
  ISOLATION_SERIALIZABLE: unknown;
};

function isolationConstant(level: IsolationLevel | undefined): unknown {
  switch (level) {
    case "READ_COMMITTED_READ_ONLY":
      return fb.ISOLATION_READ_COMMITTED_READ_ONLY;
    case "REPEATABLE_READ":
      return fb.ISOLATION_REPEATABLE_READ;
    case "SERIALIZABLE":
      return fb.ISOLATION_SERIALIZABLE;
    case "READ_COMMITTED":
    default:
      return fb.ISOLATION_READ_COMMITTED;
  }
}

/**
 * Firebird implementation of SqlDriver. Wraps node-firebird's callback API in
 * promises, manages a connection pool, and guarantees every query executes
 * inside a transaction. Nested `transaction()` calls reuse the active one via
 * AsyncLocalStorage so `client.$transaction(...)` composes naturally.
 */
export class FirebirdDriver implements SqlDriver {
  private pool: FbPool | null = null;
  private readonly options: Record<string, unknown>;
  private readonly poolMax: number;
  private readonly onQuery?: DriverOptions["onQuery"];
  private readonly activeTx = new AsyncLocalStorage<TransactionContext>();

  constructor(config: ConnectionConfig, driverOptions?: DriverOptions) {
    this.poolMax = config.poolMax ?? 5;
    this.onQuery = driverOptions?.onQuery;
    this.options = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      role: config.role ?? "",
      pageSize: config.pageSize ?? 4096,
      encoding: config.encoding ?? "UTF8",
      blobAsText: config.blobAsText ?? true,
      lowercase_keys: config.lowercaseKeys ?? false,
      retryConnectionInterval: 1000,
      // FB3+ secure auth (Srp) is negotiated by default; set explicitly to force
      // a plugin, or "Legacy_Auth" for Firebird 2.1/2.5 servers.
      ...(config.authPlugin ? { pluginName: config.authPlugin } : {}),
      ...(config.wireCompression != null
        ? { wireCompression: config.wireCompression }
        : {}),
    };
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = fb.pool(this.poolMax, this.options);
  }

  async disconnect(): Promise<void> {
    if (!this.pool) return;
    this.pool.destroy();
    this.pool = null;
  }

  async transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const existing = this.activeTx.getStore();
    if (existing) {
      // Reuse the enclosing transaction; do not commit here.
      return fn(existing);
    }
    await this.connect();
    const db = await this.acquire();
    const tr = await this.begin(db, options?.isolation);
    const ctx: TransactionContext = {
      query: (sql, params) => this.runOnTransaction(tr, sql, params),
    };
    try {
      const result = await this.activeTx.run(ctx, () => fn(ctx));
      await this.commit(tr);
      return result;
    } catch (err) {
      await this.safeRollback(tr);
      throw err;
    } finally {
      db.detach();
    }
  }

  // ---- promise wrappers over node-firebird -------------------------------

  private acquire(): Promise<FbDatabase> {
    return new Promise((resolve, reject) => {
      this.pool!.get((err, db) => {
        if (err) return reject(wrap(err, "Failed to acquire connection"));
        resolve(db);
      });
    });
  }

  private begin(
    db: FbDatabase,
    isolation?: IsolationLevel,
  ): Promise<FbTransaction> {
    return new Promise((resolve, reject) => {
      db.transaction(isolationConstant(isolation), (err, tr) => {
        if (err) return reject(wrap(err, "Failed to start transaction"));
        resolve(tr);
      });
    });
  }

  private runOnTransaction<T>(
    tr: FbTransaction,
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    const start = this.onQuery ? performance.now() : 0;
    return new Promise((resolve, reject) => {
      tr.query(sql, [...params], (err, result) => {
        if (err) return reject(wrap(err, "Query failed", sql));
        const rows = normalizeRows<T>(result);
        if (this.onQuery) {
          this.onQuery({
            sql,
            params,
            durationMs: performance.now() - start,
            rowCount: rows.length,
          });
        }
        resolve(rows);
      });
    });
  }

  private commit(tr: FbTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tr.commit((err) => {
        if (err) return reject(wrap(err, "Failed to commit transaction"));
        resolve();
      });
    });
  }

  private safeRollback(tr: FbTransaction): Promise<void> {
    return new Promise((resolve) => {
      tr.rollback(() => resolve());
    });
  }
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result === undefined || result === null) return [];
  return [result as T];
}

function wrap(err: unknown, message: string, sql?: string): DatabaseError {
  const detail =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return new DatabaseError(`${message}: ${detail}`, err, sql);
}
