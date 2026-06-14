import type { SchemaDocument } from "@ember/ast";
import {
  createDriver,
  parseConnectionUrl,
  type ConnectionConfig,
  type QueryEvent,
  type QueryLogger,
  type SqlDriver,
  type TransactionOptions,
} from "@ember/driver";
import { EmberError } from "@ember/errors";
import { FirebirdDialect, type SqlDialect } from "@ember/sql";
import { QueryEngine } from "@ember/query";
import { resolveDatasourceUrl } from "@ember/schema";
import { lowerFirst } from "@ember/utils";
import { type ModelDelegate } from "./delegate";
import {
  buildDelegate,
  type DelegateContext,
  type EmberExtensionArgs,
  type Middleware,
} from "./runtime";

export type { ModelDelegate } from "./delegate";
export type {
  EmberExtensionArgs,
  Middleware,
  QueryHook,
  QueryHookParams,
  ResultFieldExtension,
} from "./runtime";
export type { QueryEvent, QueryLogger } from "@ember/driver";

export interface ClientOptions {
  /** Connection URL or explicit config. Overrides the schema datasource. */
  datasourceUrl?: string;
  datasource?: ConnectionConfig;
  /** A pre-parsed schema document (the generated client passes its own). */
  schema: SchemaDocument;
  /**
   * Query logging: `true` logs each statement to the console; pass a function
   * to receive structured `QueryEvent`s (sql, params, durationMs, rowCount).
   */
  log?: boolean | QueryLogger;
}

/**
 * Runtime client. Builds one delegate per model from the schema and exposes
 * Prisma-style lifecycle and transaction helpers. The generated client extends
 * this and adds strongly-typed delegate properties.
 */
export class EmberClientBase {
  protected readonly driver: SqlDriver;
  protected readonly engine: QueryEngine;
  protected readonly dialect: SqlDialect;
  protected readonly schema: SchemaDocument;
  private connected = false;

  /** Mutated by $extends (per instance) and $use (shared). */
  protected extensions: EmberExtensionArgs[] = [];
  protected middlewares: Middleware[] = [];
  private readonly queryListeners: QueryLogger[] = [];
  private readonly baseLog?: QueryLogger;

  /** Dynamic model delegates, keyed by camelCased model name. */
  [delegate: string]: unknown;

  constructor(options: ClientOptions) {
    this.schema = options.schema;

    const url =
      options.datasourceUrl ?? resolveDatasourceUrl(options.schema, process.cwd());
    if (!options.datasource && !url) {
      throw new EmberError(
        "No datasource configured. Provide datasourceUrl, datasource, or a datasource block with a resolvable url.",
      );
    }
    const config: ConnectionConfig =
      options.datasource ?? parseConnectionUrl(url!);

    this.dialect = new FirebirdDialect({ version: config.version });
    this.baseLog = buildLogger(options.log);

    this.driver = createDriver(config, { onQuery: (e) => this.dispatchQuery(e) });
    this.engine = new QueryEngine(options.schema, this.dialect, this.driver);

    this.installDelegates();
  }

  private dispatchQuery(event: QueryEvent): void {
    this.baseLog?.(event);
    for (const listener of this.queryListeners) listener(event);
  }

  private delegateContext(): DelegateContext {
    return {
      engine: this.engine,
      schema: this.schema,
      extensions: this.extensions,
      middlewares: this.middlewares,
    };
  }

  /** (Re)define one delegate property per model using the current extensions. */
  private installDelegates(): void {
    const ctx = this.delegateContext();
    for (const model of this.schema.models) {
      Object.defineProperty(this, lowerFirst(model.name), {
        value: buildDelegate(ctx, model.name),
        enumerable: true,
        configurable: true,
      });
    }
  }

  /**
   * Prisma-style Client Extensions. Returns a new client (the original is
   * unchanged) that shares the connection/engine but applies the extension's
   * `result` / `model` / `query` / `client` definitions.
   */
  $extends(extension: EmberExtensionArgs): this {
    const clone: this = Object.create(this);
    clone.extensions = [...this.extensions, extension];
    clone.installDelegates();
    if (extension.client) {
      for (const [key, value] of Object.entries(extension.client)) {
        Object.defineProperty(clone, key, {
          value: typeof value === "function" ? value.bind(clone) : value,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return clone;
  }

  /** Prisma-style middleware: runs around every operation. */
  $use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  /** Subscribe to query events (mirrors the `log` callback). */
  $on(event: "query", listener: QueryLogger): void {
    if (event === "query") this.queryListeners.push(listener);
  }

  /** Type-safe access to a delegate by model name. */
  model(name: string): ModelDelegate {
    return this[lowerFirst(name)] as ModelDelegate;
  }

  async $connect(): Promise<void> {
    if (this.connected) return;
    await this.driver.connect();
    this.connected = true;
  }

  async $disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.driver.disconnect();
    this.connected = false;
  }

  /**
   * Run work inside a single transaction.
   * - Interactive form: `$transaction(async (tx) => { ... })`.
   * - Sequential form: `$transaction([(tx) => tx.user.create(...), ...])`.
   *
   * Because the driver tracks the active transaction via AsyncLocalStorage,
   * every delegate call made on the passed client runs in the same transaction.
   */
  $transaction<T>(
    fn: (tx: this) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  $transaction<T>(
    thunks: ((tx: this) => Promise<T>)[],
    options?: TransactionOptions,
  ): Promise<T[]>;
  $transaction<T>(
    arg: ((tx: this) => Promise<T>) | ((tx: this) => Promise<T>)[],
    options?: TransactionOptions,
  ): Promise<T | T[]> {
    if (Array.isArray(arg)) {
      return this.driver.transaction(async () => {
        const results: T[] = [];
        for (const thunk of arg) results.push(await thunk(this));
        return results;
      }, options);
    }
    return this.driver.transaction(() => arg(this), options);
  }

  /** Execute a raw read query (returns rows) inside a transaction. */
  $queryRawUnsafe<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.driver.transaction((tx) =>
      tx.query<T>(sql, params.map(toSqlValue)),
    );
  }

  /** Execute a raw write statement inside a transaction; returns affected rows when available. */
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    return this.driver.transaction(async (tx) => {
      const rows = await tx.query(sql, params.map(toSqlValue));
      return Array.isArray(rows) ? rows.length : 0;
    });
  }

  /** Tagged-template raw query: `client.$queryRaw\`SELECT * FROM T WHERE id = ${id}\``. */
  $queryRaw<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    const { sql, params } = buildTemplate(strings, values);
    return this.$queryRawUnsafe<T>(sql, ...params);
  }

  $executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number> {
    const { sql, params } = buildTemplate(strings, values);
    return this.$executeRawUnsafe(sql, ...params);
  }
}

function buildTemplate(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: unknown[] } {
  let sql = "";
  strings.forEach((part, i) => {
    sql += part;
    if (i < values.length) sql += "?";
  });
  return { sql, params: values };
}

function toSqlValue(v: unknown): never {
  return v as never;
}

/** Resolve the `log` option into a driver query hook. */
function buildLogger(
  log: ClientOptions["log"],
): QueryLogger | undefined {
  if (!log) return undefined;
  if (typeof log === "function") return log;
  return (e: QueryEvent) => {
    const params = e.params.length ? ` -- ${JSON.stringify(e.params)}` : "";
    // eslint-disable-next-line no-console
    console.log(
      `ember:query (${e.durationMs.toFixed(1)}ms, ${e.rowCount} rows) ${e.sql}${params}`,
    );
  };
}

/**
 * Factory for an untyped client when you don't use the generated client.
 * Prefer the generated `EmberClient` for full type-safety.
 */
export function createClient(options: ClientOptions): EmberClientBase {
  return new EmberClientBase(options);
}
