export type {
  ConnectionConfig,
  FirebirdVersion,
  DriverOptions,
  QueryEvent,
  QueryLogger,
  SqlDriver,
  SqlValue,
  TransactionContext,
  TransactionOptions,
  IsolationLevel,
} from "./types";
export { FirebirdDriver } from "./firebird-driver";
export { parseConnectionUrl, buildConnectionUrl } from "./url";

import type { ConnectionConfig, DriverOptions, SqlDriver } from "./types";
import { FirebirdDriver } from "./firebird-driver";
import { parseConnectionUrl } from "./url";

/**
 * Factory that builds a driver from either a connection URL or an explicit
 * config object. Centralizing creation here keeps the client decoupled from a
 * concrete driver class (Factory pattern / DIP).
 */
export function createDriver(
  source: string | ConnectionConfig,
  options?: DriverOptions,
): SqlDriver {
  const config =
    typeof source === "string" ? parseConnectionUrl(source) : source;
  return new FirebirdDriver(config, options);
}
