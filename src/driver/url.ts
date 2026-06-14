import { EmberError } from "@ember/errors";
import type { ConnectionConfig } from "./types";

/**
 * Parse a Firebird connection URL into a ConnectionConfig.
 *
 * Supported forms:
 *   firebird://user:password@host:port/path/to/database.fdb?role=RDB$ADMIN
 *   firebird://SYSDBA:masterkey@localhost:3050//var/lib/firebird/data/app.fdb
 *   firebird://SYSDBA:masterkey@localhost:3050/MYALIAS          ← Firebird alias (auto-detected)
 *   firebird://SYSDBA:masterkey@localhost:3050?alias=MYALIAS    ← Firebird alias (explicit)
 *
 * The path after the host is treated as the absolute database path. A leading
 * double slash (`//var/...`) yields an absolute POSIX path; a single slash with
 * a Windows drive (`/C:/...`) is normalized too. A single path segment with no
 * dots or sub-directories is treated as a Firebird alias (resolved server-side
 * via aliases.conf / databases.conf).
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

  const params = parsed.searchParams;
  // Explicit ?alias= param takes precedence over the URL path.
  const database = params.get("alias") ?? resolveDatabasePath(parsed.pathname);
  if (!database) {
    throw new EmberError(
      `Connection URL requires a database path or ?alias=NAME: ${url}`,
    );
  }

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

/**
 * Resolve the URL pathname to a database path or alias name.
 *
 * - Single identifier (e.g. `/MYALIAS`) → Firebird alias (`MYALIAS`)
 * - Double-slash prefix (`//var/lib/app.fdb`) → absolute POSIX path (`/var/lib/app.fdb`)
 * - Windows drive (`/C:/db.fdb`) → `C:/db.fdb`
 * - All other paths are returned as-is.
 */
function resolveDatabasePath(pathname: string): string {
  const p = decodeURIComponent(pathname);
  // Single identifier with no sub-path or extension → Firebird alias
  if (/^\/[A-Za-z][A-Za-z0-9_]*$/.test(p)) return p.slice(1);
  // Absolute POSIX path via double-slash: //var/lib/app.fdb → /var/lib/app.fdb
  if (p.startsWith("//")) return p.slice(1);
  // Windows absolute path: /C:/db.fdb → C:/db.fdb
  if (/^\/[A-Za-z]:\//.test(p)) return p.slice(1);
  return p;
}

export function buildConnectionUrl(config: ConnectionConfig): string {
  const auth = `${encodeURIComponent(config.user)}:${encodeURIComponent(
    config.password,
  )}`;
  const isAlias = !config.database.includes("/");
  const dbPath = isAlias ? "" : `/${config.database}`;
  const url = new URL(`firebird://${auth}@${config.host}:${config.port}${dbPath}`);
  if (config.role) url.searchParams.set("role", config.role);
  if (isAlias) url.searchParams.set("alias", config.database);
  return url.toString();
}
