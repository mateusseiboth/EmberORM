import { EmberError } from "@ember/errors";
import type { ConnectionConfig } from "./types";

/**
 * Parse a Firebird connection URL into a ConnectionConfig.
 *
 * Supported forms:
 *   firebird://user:password@host:port/path/to/database.fdb?role=RDB$ADMIN
 *   firebird://SYSDBA:masterkey@localhost:3050//var/lib/firebird/data/app.fdb
 *
 * The path after the host is treated as the absolute database path. A leading
 * double slash (`//var/...`) yields an absolute POSIX path; a single slash with
 * a Windows drive (`/C:/...`) is normalized too.
 */
export function parseConnectionUrl(url: string): ConnectionConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EmberError(`Invalid Firebird connection URL: ${url}`);
  }

  if (!/^firebird:?$/.test(parsed.protocol.replace(":", "") + ":")) {
    if (parsed.protocol !== "firebird:") {
      throw new EmberError(
        `Unsupported protocol '${parsed.protocol}'. Expected 'firebird:'.`,
      );
    }
  }

  const database = normalizeDatabasePath(parsed.pathname);
  if (!database) {
    throw new EmberError(`Connection URL is missing a database path: ${url}`);
  }

  const params = parsed.searchParams;
  const config: ConnectionConfig = {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 3050,
    database,
    user: decodeURIComponent(parsed.username || "SYSDBA"),
    password: decodeURIComponent(parsed.password || "masterkey"),
    encoding: params.get("encoding") ?? "UTF8",
  };

  const role = params.get("role");
  if (role) config.role = role;
  const poolMax = params.get("poolMax") ?? params.get("connection_limit");
  if (poolMax) config.poolMax = Number(poolMax);
  const pageSize = params.get("pageSize");
  if (pageSize) config.pageSize = Number(pageSize);

  const auth = (params.get("authPlugin") ?? params.get("auth"))?.toLowerCase();
  if (auth === "legacy" || auth === "legacy_auth") config.authPlugin = "Legacy_Auth";
  else if (auth === "srp") config.authPlugin = "Srp";

  const wireCompression = params.get("wireCompression");
  if (wireCompression != null) {
    config.wireCompression = wireCompression !== "false" && wireCompression !== "0";
  }

  const version = params.get("version");
  if (version) config.version = normalizeVersion(version);

  return config;
}

const VERSIONS = new Set(["2.1", "2.5", "3", "4", "5"]);

function normalizeVersion(raw: string): ConnectionConfig["version"] {
  const trimmed = raw.trim();
  if (VERSIONS.has(trimmed)) return trimmed as ConnectionConfig["version"];
  // Accept "3.0", "4.0.1" etc. by taking the major (or major.minor for 2.x).
  if (/^2\.1/.test(trimmed)) return "2.1";
  if (/^2\.5/.test(trimmed)) return "2.5";
  const major = trimmed.split(".")[0];
  if (major && VERSIONS.has(major)) return major as ConnectionConfig["version"];
  return undefined;
}

function normalizeDatabasePath(pathname: string): string {
  let p = decodeURIComponent(pathname);
  // `//var/lib/app.fdb` -> `/var/lib/app.fdb`
  if (p.startsWith("//")) p = p.slice(1);
  // `/C:/db.fdb` -> `C:/db.fdb`
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

export function buildConnectionUrl(config: ConnectionConfig): string {
  const auth = `${encodeURIComponent(config.user)}:${encodeURIComponent(
    config.password,
  )}`;
  const dbPath = config.database.startsWith("/")
    ? `/${config.database}`
    : `/${config.database}`;
  const url = new URL(`firebird://${auth}@${config.host}:${config.port}${dbPath}`);
  if (config.role) url.searchParams.set("role", config.role);
  return url.toString();
}
