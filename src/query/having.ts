import { type ModelNode, fieldColumn } from "@ember/ast";
import { QueryValidationError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import { isPlainObject } from "@ember/utils";
import type { WhereInput } from "./args";
import { type CompileContext, compileWhere } from "./where";

const AGG_FN: Record<string, string> = {
  _count: "COUNT",
  _sum: "SUM",
  _avg: "AVG",
  _min: "MIN",
  _max: "MAX",
};

const COMPARATORS: Record<string, string> = {
  equals: "=",
  not: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * Compile a groupBy `having` clause. Keys may be:
 * - `AND` / `OR` / `NOT` — boolean composition;
 * - a scalar field with a normal filter — a condition on the group column;
 * - a scalar field wrapping aggregates (`{ field: { _sum: { gt } } }`) — a
 *   condition on `SUM(col)`, `AVG(col)`, etc.;
 * - a top-level aggregate (`{ _count: { field: { gt } } }`).
 */
export function compileHaving(
  model: ModelNode,
  alias: string,
  having: WhereInput | undefined,
  ctx: CompileContext,
): Sql {
  if (!having || Object.keys(having).length === 0) return new Sql();
  const parts: Sql[] = [];

  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;

    if (key === "AND" || key === "OR") {
      const list = (Array.isArray(value) ? value : [value]) as WhereInput[];
      const compiled = list
        .map((w) => compileHaving(model, alias, w, ctx))
        .filter((s) => !s.isEmpty());
      if (compiled.length) parts.push(joinBool(compiled, key));
      continue;
    }
    if (key === "NOT") {
      const inner = compileHaving(model, alias, value as WhereInput, ctx);
      if (!inner.isEmpty()) parts.push(new Sql().push("NOT (").append(inner).push(")"));
      continue;
    }

    // Top-level aggregate, e.g. { _count: { id: { gt: 1 } } }.
    if (key in AGG_FN) {
      parts.push(...aggregateConditions(model, alias, key, value, ctx));
      continue;
    }

    const field = model.fields.find((f) => f.name === key && f.kind !== "object");
    if (!field) {
      throw new QueryValidationError(
        `Unknown having field '${model.name}.${key}'.`,
      );
    }

    if (isAggregateWrapper(value)) {
      const ref = ctx.dialect.quoteRef(alias, fieldColumn(field));
      for (const [agg, filter] of Object.entries(value as Record<string, unknown>)) {
        if (!(agg in AGG_FN)) continue;
        parts.push(comparison(`${AGG_FN[agg]}(${ref})`, filter, ctx.dialect));
      }
    } else {
      // Plain condition on the group column — reuse the where compiler.
      const cond = compileWhere(model, alias, { [key]: value }, ctx);
      if (!cond.isEmpty()) parts.push(cond);
    }
  }

  const nonEmpty = parts.filter((p) => !p.isEmpty());
  if (nonEmpty.length === 0) return new Sql();
  return joinBool(nonEmpty, "AND");
}

function aggregateConditions(
  model: ModelNode,
  alias: string,
  agg: string,
  spec: unknown,
  ctx: CompileContext,
): Sql[] {
  if (!isPlainObject(spec)) return [];
  const out: Sql[] = [];
  for (const [fieldName, filter] of Object.entries(spec)) {
    const field = model.fields.find((f) => f.name === fieldName && f.kind !== "object");
    if (!field) continue;
    const ref = ctx.dialect.quoteRef(alias, fieldColumn(field));
    out.push(comparison(`${AGG_FN[agg]}(${ref})`, filter, ctx.dialect));
  }
  return out;
}

function comparison(lhs: string, filter: unknown, dialect: SqlDialect): Sql {
  if (!isPlainObject(filter)) {
    return new Sql().push(`${lhs} = `).bind(dialect.coerceValue(filter));
  }
  const parts: Sql[] = [];
  for (const [op, v] of Object.entries(filter)) {
    const sqlOp = COMPARATORS[op];
    if (!sqlOp) {
      throw new QueryValidationError(`Unsupported having operator '${op}'.`);
    }
    parts.push(new Sql().push(`${lhs} ${sqlOp} `).bind(dialect.coerceValue(v)));
  }
  return parts.length === 1 ? parts[0]! : joinBool(parts, "AND");
}

function isAggregateWrapper(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).some((k) => k in AGG_FN);
}

function joinBool(parts: Sql[], op: "AND" | "OR"): Sql {
  if (parts.length === 1) return parts[0]!;
  const joined = Sql.join(
    parts.map((p) => new Sql().push("(").append(p).push(")")),
    ` ${op} `,
  );
  return new Sql().push("(").append(joined).push(")");
}
