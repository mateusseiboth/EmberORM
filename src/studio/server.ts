/**
 * EmberStudio HTTP server.
 *
 * A thin JSON wrapper over an {@link EmberClientBase} instance — every data
 * operation goes through `client.model(name).<op>()`, so the Studio reuses the
 * full query engine (where/orderBy/select/coercion) and never re-implements
 * SQL. Static SPA assets (built by Vite into `dist/studio/web`) are served for
 * every non-`/api` route.
 *
 * The server binds to a loopback host only. It exposes the database with no
 * authentication and is intended for local development use, like Prisma Studio.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaDocument } from "@ember/ast";
import type { QueryEvent } from "@ember/driver";
import {
  EmberError,
  QueryValidationError,
  RecordNotFoundError,
  SchemaValidationError,
} from "@ember/errors";
import type { EmberClientBase } from "@ember/client";
import {
  deserializeData,
  deserializeWhere,
  serializeRow,
  serializeRows,
  serializeValue,
} from "./serialize";
import { buildStudioSchema, type StudioSchema } from "./schema-meta";

export interface StudioServerOptions {
  client: EmberClientBase;
  schema: SchemaDocument;
  port?: number;
  host?: string;
  /** Override the directory holding the built SPA (defaults to dist/studio/web). */
  webRoot?: string;
}

export interface StudioServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 5757;
const DEFAULT_HOST = "127.0.0.1";
/** How many recent query events the Console tab keeps. */
const QUERY_LOG_LIMIT = 200;

/** A query event captured for the Console, with a wall-clock timestamp. */
interface LoggedQuery {
  sql: string;
  params: unknown[];
  durationMs: number;
  rowCount: number;
  at: number;
}

/**
 * Resolve the directory of built SPA assets (`<pkg>/dist/studio/web`).
 *
 * This module may be bundled into `dist/cli/bin.js` *or* `dist/studio/server.js`
 * (tsup inlines studio into the CLI), so we cannot anchor on this file's own
 * path. Instead we walk up to the nearest `package.json` (the package root) and
 * join `dist/studio/web` from there — correct both in this repo and when
 * installed under `node_modules`.
 */
function defaultWebRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return join(dir, "dist", "studio", "web");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume we are inside dist/<entry>/ and hop to dist/studio/web.
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "studio", "web");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Start the Studio server and resolve once it is listening. */
export function startStudioServer(
  options: StudioServerOptions,
): Promise<StudioServer> {
  const { client, schema } = options;
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const webRoot = options.webRoot ?? defaultWebRoot();
  const studioSchema = buildStudioSchema(schema);

  // Capture every statement the engine runs so the Console tab can show it.
  const queryLog: LoggedQuery[] = [];
  client.$on("query", (e: QueryEvent) => {
    queryLog.push({
      sql: e.sql,
      params: [...e.params],
      durationMs: e.durationMs,
      rowCount: e.rowCount,
      at: Date.now(),
    });
    if (queryLog.length > QUERY_LOG_LIMIT) queryLog.shift();
  });

  const server = createServer((req, res) => {
    handle(req, res, { client, schema, studioSchema, webRoot, queryLog }).catch((err) => {
      sendError(res, err);
    });
  });

  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      res({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((e) => (e ? fail(e) : done())),
          ),
      });
    });
  });
}

interface HandlerContext {
  client: EmberClientBase;
  schema: SchemaDocument;
  studioSchema: StudioSchema;
  webRoot: string;
  queryLog: LoggedQuery[];
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url.pathname.slice(5), ctx);
    return;
  }
  await serveStatic(res, url.pathname, ctx.webRoot);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  ctx: HandlerContext,
): Promise<void> {
  if (route === "schema") {
    sendJson(res, 200, ctx.studioSchema);
    return;
  }

  if (route === "log") {
    sendJson(res, 200, { queries: ctx.queryLog.map(serializeValue) });
    return;
  }

  if (route === "query") {
    const body = await readJsonBody(req);
    const result = await runRawSql(ctx.client, String(body.sql ?? ""));
    sendJson(res, 200, result);
    return;
  }

  const [modelName, op] = route.split("/");
  if (!modelName || !op) {
    sendJson(res, 404, { error: `Unknown API route /api/${route}` });
    return;
  }
  if (!ctx.schema.models.some((m) => m.name === modelName)) {
    sendJson(res, 404, { error: `Unknown model '${modelName}'` });
    return;
  }

  const body = await readJsonBody(req);
  const delegate = ctx.client.model(modelName);

  switch (op) {
    case "findMany": {
      const args = readArgs(body, modelName, ctx.schema);
      const rows = await delegate.findMany(args);
      sendJson(res, 200, { rows: serializeRows(rows) });
      return;
    }
    case "count": {
      const where = deserializeWhere(body.where as never, modelName, ctx.schema);
      const count = await delegate.count(where ? { where } : {});
      sendJson(res, 200, { count });
      return;
    }
    case "create": {
      const data = deserializeData(
        (body.data ?? {}) as Record<string, unknown>,
        modelName,
        ctx.schema,
      );
      const row = await delegate.create({ data });
      sendJson(res, 200, { row: serializeRow(row) });
      return;
    }
    case "update": {
      const where = deserializeWhere(body.where as never, modelName, ctx.schema);
      const data = deserializeData(
        (body.data ?? {}) as Record<string, unknown>,
        modelName,
        ctx.schema,
      );
      const row = await delegate.update({ where: where ?? {}, data });
      sendJson(res, 200, { row: serializeRow(row) });
      return;
    }
    case "delete": {
      const where = deserializeWhere(body.where as never, modelName, ctx.schema);
      const row = await delegate.delete({ where: where ?? {} });
      sendJson(res, 200, { row: serializeRow(row) });
      return;
    }
    default:
      sendJson(res, 404, { error: `Unknown operation '${op}'` });
  }
}

/** Build a sanitized `findMany` arg object from the request body. */
function readArgs(
  body: Record<string, unknown>,
  modelName: string,
  schema: SchemaDocument,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const where = deserializeWhere(body.where as never, modelName, schema);
  if (where) args.where = where;
  if (body.orderBy) args.orderBy = body.orderBy;
  if (typeof body.skip === "number") args.skip = body.skip;
  if (typeof body.take === "number") args.take = body.take;
  if (body.select) args.select = body.select;
  if (body.include) args.include = body.include;
  return args;
}

/**
 * Run an arbitrary SQL statement from the SQL tab. Read statements
 * (`SELECT`/`WITH`) return rows + column order; anything else is executed and
 * reports the affected-row count. Trailing semicolons are trimmed because
 * Firebird rejects them on single statements.
 */
async function runRawSql(
  client: EmberClientBase,
  sql: string,
): Promise<{ rows?: Record<string, unknown>[]; columns?: string[]; rowCount?: number }> {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement) throw new QueryValidationError("SQL statement is empty.");

  if (/^(select|with)\b/i.test(statement)) {
    const rows = await client.$queryRawUnsafe(statement);
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { rows: serializeRows(rows), columns };
  }

  const rowCount = await client.$executeRawUnsafe(statement);
  return { rowCount };
}

// ---- static assets --------------------------------------------------------

async function serveStatic(
  res: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<void> {
  // Resolve within webRoot; fall back to index.html for SPA client routes.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(webRoot, rel === "/" || rel === "." ? "index.html" : rel);
  if (!file.startsWith(webRoot)) file = join(webRoot, "index.html");
  if (!existsSync(file)) file = join(webRoot, "index.html");

  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "EmberStudio web assets not found. Run `npm run build` to build the UI.",
    );
    return;
  }

  const data = await readFile(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(data);
}

// ---- helpers --------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    throw new QueryValidationError("Request body is not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  const status = statusFor(err);
  const message = err instanceof Error ? err.message : String(err);
  if (!res.headersSent) sendJson(res, status, { error: message });
  else res.end();
}

function statusFor(err: unknown): number {
  if (err instanceof QueryValidationError || err instanceof SchemaValidationError) {
    return 400;
  }
  if (err instanceof RecordNotFoundError) return 404;
  if (err instanceof EmberError) return 422;
  return 500;
}
