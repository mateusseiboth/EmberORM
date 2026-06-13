import type { SchemaDocument } from "@ember/ast";
import {
  createDriver,
  type ConnectionConfig,
  type SqlDriver,
  type TransactionOptions,
} from "@ember/driver";
import { EmberError } from "@ember/errors";
import { FirebirdDialect, type SqlDialect } from "@ember/sql";
import { QueryEngine } from "@ember/query";
import { resolveDatasourceUrl } from "@ember/schema";
import { lowerFirst } from "@ember/utils";
import { createDelegate, type ModelDelegate } from "./delegate";

export type { ModelDelegate } from "./delegate";

export interface ClientOptions {
  /** Connection URL or explicit config. Overrides the schema datasource. */
  datasourceUrl?: string;
  datasource?: ConnectionConfig;
  /** A pre-parsed schema document (the generated client passes its own). */
  schema: SchemaDocument;
  log?: boolean;
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

  /** Dynamic model delegates, keyed by camelCased model name. */
  [delegate: string]: unknown;

  constructor(options: ClientOptions) {
    this.schema = options.schema;
    this.dialect = new FirebirdDialect();

    const url =
      options.datasourceUrl ?? resolveDatasourceUrl(options.schema, process.cwd());
    if (!options.datasource && !url) {
      throw new EmberError(
        "No datasource configured. Provide datasourceUrl, datasource, or a datasource block with a resolvable url.",
      );
    }
    this.driver = createDriver(options.datasource ?? url!);
    this.engine = new QueryEngine(options.schema, this.dialect, this.driver);

    for (const model of options.schema.models) {
      const key = lowerFirst(model.name);
      Object.defineProperty(this, key, {
        value: createDelegate(this.engine, model.name),
        enumerable: true,
        writable: false,
      });
    }
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

/**
 * Factory for an untyped client when you don't use the generated client.
 * Prefer the generated `EmberClient` for full type-safety.
 */
export function createClient(options: ClientOptions): EmberClientBase {
  return new EmberClientBase(options);
}
