import {
  type FieldNode,
  type ModelNode,
  fieldColumn,
  idFields,
  modelTable,
} from "@ember/ast";
import { QueryValidationError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import type { SqlValue } from "@ember/driver";
import type { AggregateArgs, OrderByInput, SortOrder, WhereInput } from "./args";
import { compileOrderBy } from "./order";
import { compileHaving } from "./having";
import { type CompileContext, compileWhere } from "./where";

export interface SelectStatement {
  sql: Sql;
  /** Scalar fields projected, in result order. */
  columns: FieldNode[];
}

/**
 * A single column assignment in an UPDATE. `set` binds a literal value;
 * `arith` produces `"COL" = "COL" <op> ?` for atomic numeric operators
 * (increment/decrement/multiply/divide).
 */
export type ColumnUpdate =
  | { kind: "set"; value: SqlValue }
  | { kind: "arith"; op: "+" | "-" | "*" | "/"; value: SqlValue };

/** Wrap a plain column→value map as a set-only ColumnUpdate map. */
export function setAssignments(
  values: Map<string, SqlValue>,
): Map<string, ColumnUpdate> {
  const out = new Map<string, ColumnUpdate>();
  for (const [col, value] of values) out.set(col, { kind: "set", value });
  return out;
}

const ROOT_ALIAS = "t0";

export function newContext(
  schema: CompileContext["schema"],
  dialect: SqlDialect,
): CompileContext {
  return { schema, dialect, alias: { next: 1 } };
}

interface FindOptions {
  where?: WhereInput;
  orderBy?: OrderByInput;
  take?: number;
  skip?: number;
}

/** SELECT <projection> FROM model [WHERE] [ORDER BY] with FIRST/SKIP pagination. */
export function compileFindMany(
  model: ModelNode,
  options: FindOptions,
  projection: FieldNode[],
  ctx: CompileContext,
): SelectStatement {
  const d = ctx.dialect;
  const cols = projection.map(
    (f) =>
      `${d.quoteRef(ROOT_ALIAS, fieldColumn(f))} AS ${d.quoteId(f.name)}`,
  );
  const sql = new Sql();
  const pagination = d.paginationClause(options.take, options.skip);
  sql.push(pagination ? `SELECT ${pagination} ` : "SELECT ");
  sql.push(cols.join(", "));
  sql.push(` FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`);

  appendWhere(sql, model, options.where, ctx);
  const order = compileOrderBy(model, ROOT_ALIAS, options.orderBy, d);
  if (!order.isEmpty()) sql.push(" ORDER BY ").append(order);

  return { sql, columns: projection };
}

/**
 * SELECT ... with `distinct` pushed to SQL via ROW_NUMBER() (Firebird 3+).
 * Keeps the first row per distinct-field tuple in `orderBy` order, then applies
 * pagination on the outer query:
 *
 *   SELECT FIRST/SKIP <cols> FROM (
 *     SELECT <cols>, ROW_NUMBER() OVER (PARTITION BY <distinct> ORDER BY <ord>) "__rn"
 *     FROM <table> t0 [WHERE ...]
 *   ) sub WHERE sub."__rn" = 1 [ORDER BY ...]
 */
export function compileDistinctFindMany(
  model: ModelNode,
  options: FindOptions,
  projection: FieldNode[],
  distinctFields: FieldNode[],
  ctx: CompileContext,
): SelectStatement {
  const d = ctx.dialect;
  const innerOrder = options.orderBy
    ? compileOrderBy(model, ROOT_ALIAS, options.orderBy, d)
    : defaultOrder(model, d);
  const partitionBy = distinctFields
    .map((f) => d.quoteRef(ROOT_ALIAS, fieldColumn(f)))
    .join(", ");

  const inner = new Sql();
  const innerCols = projection.map(
    (f) => `${d.quoteRef(ROOT_ALIAS, fieldColumn(f))} AS ${d.quoteId(f.name)}`,
  );
  inner.push(`SELECT ${innerCols.join(", ")}, ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY `);
  inner.append(innerOrder);
  inner.push(`) AS ${d.quoteId("__rn")}`);
  inner.push(` FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`);
  appendWhere(inner, model, options.where, ctx);

  const sql = new Sql();
  const pagination = d.paginationClause(options.take, options.skip);
  const sub = "sub";
  const outerCols = projection
    .map((f) => `${d.quoteRef(sub, f.name)} AS ${d.quoteId(f.name)}`)
    .join(", ");
  sql.push(pagination ? `SELECT ${pagination} ` : "SELECT ");
  sql.push(outerCols);
  sql.push(` FROM (`).append(inner).push(`) ${d.quoteId(sub)}`);
  sql.push(` WHERE ${d.quoteRef(sub, "__rn")} = 1`);

  // Re-apply ordering on the outer query (referencing the projected aliases).
  const outerOrder = outerOrderBy(model, sub, options.orderBy, d);
  if (!outerOrder.isEmpty()) sql.push(" ORDER BY ").append(outerOrder);

  return { sql, columns: projection };
}

/** SELECT COUNT(*) ... */
export function compileCount(
  model: ModelNode,
  where: WhereInput | undefined,
  ctx: CompileContext,
  pagination?: { take?: number; skip?: number },
): Sql {
  const d = ctx.dialect;
  const sql = new Sql();
  const clause = pagination
    ? d.paginationClause(pagination.take, pagination.skip)
    : "";
  sql.push(clause ? `SELECT ${clause} COUNT(*) AS "_count"` : `SELECT COUNT(*) AS "_count"`);
  sql.push(` FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`);
  appendWhere(sql, model, where, ctx);
  return sql;
}

/** Aggregate functions (_count/_avg/_sum/_min/_max) over a filtered set. */
export function compileAggregate(
  model: ModelNode,
  args: AggregateArgs,
  ctx: CompileContext,
): Sql {
  const d = ctx.dialect;
  const selects = aggregateSelections(model, args, d);
  if (selects.length === 0) {
    throw new QueryValidationError("Aggregate requires at least one operator.");
  }
  const sql = new Sql();
  sql.push(`SELECT ${selects.join(", ")}`);
  sql.push(` FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`);
  appendWhere(sql, model, args.where, ctx);
  return sql;
}

/** GROUP BY with aggregates and optional HAVING. */
export function compileGroupBy(
  model: ModelNode,
  args: AggregateArgs & { by: string[]; having?: WhereInput },
  ctx: CompileContext,
): { sql: Sql; groupColumns: FieldNode[] } {
  const d = ctx.dialect;
  const groupColumns = args.by.map((name) => requireScalar(model, name));
  const groupSelects = groupColumns.map(
    (f) => `${d.quoteRef(ROOT_ALIAS, fieldColumn(f))} AS ${d.quoteId(f.name)}`,
  );
  const aggSelects = aggregateSelections(model, args, d);

  const sql = new Sql();
  sql.push(`SELECT ${[...groupSelects, ...aggSelects].join(", ")}`);
  sql.push(` FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`);
  appendWhere(sql, model, args.where, ctx);
  sql.push(
    ` GROUP BY ${groupColumns
      .map((f) => d.quoteRef(ROOT_ALIAS, fieldColumn(f)))
      .join(", ")}`,
  );

  const having = compileHaving(model, ROOT_ALIAS, args.having, ctx);
  if (!having.isEmpty()) sql.push(" HAVING ").append(having);

  const order = compileOrderBy(model, ROOT_ALIAS, args.orderBy, d);
  if (!order.isEmpty()) sql.push(" ORDER BY ").append(order);
  return { sql, groupColumns };
}

/** INSERT ... [RETURNING ...]. `row` maps column->value (already coerced upstream). */
export function compileInsert(
  model: ModelNode,
  row: Map<string, SqlValue>,
  ctx: CompileContext,
  returning: FieldNode[],
): SelectStatement {
  const d = ctx.dialect;
  const sql = new Sql();
  const columns = [...row.keys()];
  sql.push(`INSERT INTO ${d.quoteId(modelTable(model))} (`);
  sql.push(columns.map((c) => d.quoteId(c)).join(", "));
  sql.push(") VALUES (");
  sql.bindList(columns.map((c) => row.get(c)!));
  sql.push(")");
  appendReturning(sql, d, returning);
  return { sql, columns: returning };
}

/** UPDATE table alias SET ... WHERE ... [RETURNING ...]. */
export function compileUpdate(
  model: ModelNode,
  where: WhereInput | undefined,
  assignments: Map<string, ColumnUpdate>,
  ctx: CompileContext,
  returning?: FieldNode[],
): SelectStatement {
  const d = ctx.dialect;
  if (assignments.size === 0) {
    throw new QueryValidationError("Update requires at least one field to set.");
  }
  const sql = new Sql();
  sql.push(`UPDATE ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)} SET `);
  const cols = [...assignments.keys()];
  cols.forEach((col, i) => {
    if (i > 0) sql.push(", ");
    const assignment = assignments.get(col)!;
    const quoted = d.quoteId(col);
    if (assignment.kind === "arith") {
      sql.push(`${quoted} = ${quoted} ${assignment.op} `).bind(assignment.value);
    } else {
      sql.push(`${quoted} = `).bind(assignment.value);
    }
  });
  appendWhere(sql, model, where, ctx);
  if (returning) appendReturning(sql, d, returning);
  return { sql, columns: returning ?? [] };
}

/** DELETE FROM table alias WHERE ... [RETURNING ...]. */
export function compileDelete(
  model: ModelNode,
  where: WhereInput | undefined,
  ctx: CompileContext,
  returning?: FieldNode[],
): SelectStatement {
  const d = ctx.dialect;
  const sql = new Sql();
  sql.push(
    `DELETE FROM ${d.quoteId(modelTable(model))} ${d.quoteId(ROOT_ALIAS)}`,
  );
  appendWhere(sql, model, where, ctx);
  if (returning) appendReturning(sql, d, returning);
  return { sql, columns: returning ?? [] };
}

// ---- internals ----------------------------------------------------------

function appendWhere(
  sql: Sql,
  model: ModelNode,
  where: WhereInput | undefined,
  ctx: CompileContext,
): void {
  const compiled = compileWhere(model, ROOT_ALIAS, where, ctx);
  if (!compiled.isEmpty()) sql.push(" WHERE ").append(compiled);
}

/** Deterministic default ordering (primary key, ascending) on the inner alias. */
function defaultOrder(model: ModelNode, d: SqlDialect): Sql {
  const ids = idFields(model);
  const cols = (ids.length ? ids : model.fields.filter((f) => f.kind !== "object"))
    .map((f) => `${d.quoteRef(ROOT_ALIAS, fieldColumn(f))} ASC`);
  return Sql.raw(cols.join(", "));
}

/** ORDER BY for the outer distinct query, referencing projected name aliases. */
function outerOrderBy(
  model: ModelNode,
  alias: string,
  orderBy: OrderByInput | undefined,
  d: SqlDialect,
): Sql {
  if (!orderBy) return new Sql();
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: Sql[] = [];
  for (const obj of list) {
    for (const [name, dir] of Object.entries(obj)) {
      if (dir !== "asc" && dir !== "desc") continue;
      if (!model.fields.some((f) => f.name === name && f.kind !== "object")) {
        continue;
      }
      parts.push(
        Sql.raw(`${d.quoteRef(alias, name)} ${(dir as SortOrder) === "desc" ? "DESC" : "ASC"}`),
      );
    }
  }
  return Sql.join(parts, ", ");
}

function appendReturning(sql: Sql, d: SqlDialect, returning: FieldNode[]): void {
  if (returning.length === 0) return;
  // Firebird does not accept output aliases (AS) in RETURNING, so the row comes
  // back keyed by column name. Consumers map those columns back to field names
  // (see WriteProcessor.keyValues), keeping the result aligned with the schema.
  sql.push(" RETURNING ");
  sql.push(returning.map((f) => d.quoteId(fieldColumn(f))).join(", "));
}

function aggregateSelections(
  model: ModelNode,
  args: AggregateArgs,
  d: SqlDialect,
): string[] {
  const out: string[] = [];
  if (args._count) {
    if (args._count === true) {
      out.push(`COUNT(*) AS "_count_all"`);
    } else {
      for (const field of trueKeys(args._count)) {
        const col = d.quoteRef(ROOT_ALIAS, fieldColumn(requireScalar(model, field)));
        out.push(`COUNT(${col}) AS ${d.quoteId(`_count_${field}`)}`);
      }
    }
  }
  pushAgg(out, "SUM", "_sum", model, args._sum, d);
  pushAgg(out, "AVG", "_avg", model, args._avg, d);
  pushAgg(out, "MIN", "_min", model, args._min, d);
  pushAgg(out, "MAX", "_max", model, args._max, d);
  return out;
}

function pushAgg(
  out: string[],
  fn: string,
  prefix: string,
  model: ModelNode,
  spec: Record<string, boolean> | undefined,
  d: SqlDialect,
): void {
  if (!spec) return;
  for (const field of trueKeys(spec)) {
    const col = d.quoteRef(ROOT_ALIAS, fieldColumn(requireScalar(model, field)));
    out.push(`${fn}(${col}) AS ${d.quoteId(`${prefix}_${field}`)}`);
  }
}

function trueKeys(spec: Record<string, boolean>): string[] {
  return Object.entries(spec)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

function requireScalar(model: ModelNode, name: string): FieldNode {
  const field = model.fields.find((f) => f.name === name);
  if (!field || field.kind === "object") {
    throw new QueryValidationError(
      `'${name}' is not a scalar field on model '${model.name}'.`,
    );
  }
  return field;
}
