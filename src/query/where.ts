import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  fieldColumn,
  modelTable,
} from "@ember/ast";
import { QueryValidationError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import { isPlainObject } from "@ember/utils";
import type { ScalarFilter, WhereInput } from "./args";
import { resolveRelation } from "./relations";

export interface CompileContext {
  schema: SchemaDocument;
  dialect: SqlDialect;
  alias: { next: number };
}

const SCALAR_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
]);

/**
 * Compile a `where` object for `model` (referenced by `tableAlias`) into a
 * boolean Sql fragment. All literal values are bound as `?` parameters.
 * Returns an empty fragment when the filter is empty (caller omits WHERE).
 */
export function compileWhere(
  model: ModelNode,
  tableAlias: string,
  where: WhereInput | undefined,
  ctx: CompileContext,
): Sql {
  if (!where || Object.keys(where).length === 0) return new Sql();
  const conditions: Sql[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    if (key === "AND") {
      conditions.push(combineList(asArray(value), model, tableAlias, ctx, "AND"));
      continue;
    }
    if (key === "OR") {
      conditions.push(combineList(asArray(value), model, tableAlias, ctx, "OR"));
      continue;
    }
    if (key === "NOT") {
      const inner = combineList(asArray(value), model, tableAlias, ctx, "AND");
      if (!inner.isEmpty()) {
        conditions.push(new Sql().push("NOT (").append(inner).push(")"));
      }
      continue;
    }

    const field = model.fields.find((f) => f.name === key);
    if (!field) {
      throw new QueryValidationError(
        `Unknown field '${key}' in where clause of model '${model.name}'.`,
      );
    }

    if (field.kind === "object") {
      conditions.push(
        compileRelationFilter(model, tableAlias, field, value, ctx),
      );
    } else {
      conditions.push(compileScalar(tableAlias, field, value, ctx));
    }
  }

  const nonEmpty = conditions.filter((c) => !c.isEmpty());
  if (nonEmpty.length === 0) return new Sql();
  return wrapAnd(nonEmpty);
}

function combineList(
  list: WhereInput[],
  model: ModelNode,
  tableAlias: string,
  ctx: CompileContext,
  op: "AND" | "OR",
): Sql {
  const parts = list
    .map((w) => compileWhere(model, tableAlias, w, ctx))
    .filter((p) => !p.isEmpty());
  if (parts.length === 0) return new Sql();
  if (parts.length === 1) return parts[0]!;
  const joined = Sql.join(
    parts.map((p) => new Sql().push("(").append(p).push(")")),
    ` ${op} `,
  );
  return new Sql().push("(").append(joined).push(")");
}

function wrapAnd(parts: Sql[]): Sql {
  if (parts.length === 1) return parts[0]!;
  const joined = Sql.join(
    parts.map((p) => new Sql().push("(").append(p).push(")")),
    " AND ",
  );
  return new Sql().push("(").append(joined).push(")");
}

function compileScalar(
  tableAlias: string,
  field: FieldNode,
  value: unknown,
  ctx: CompileContext,
): Sql {
  const ref = ctx.dialect.quoteRef(tableAlias, fieldColumn(field));

  // Direct value shorthand: `{ field: value }` == `{ field: { equals: value } }`.
  if (!isFilterObject(value)) {
    if (value === null) return Sql.raw(`${ref} IS NULL`);
    return new Sql().push(`${ref} = `).bind(ctx.dialect.coerceValue(value));
  }

  const filter = value as ScalarFilter;
  const insensitive = filter.mode === "insensitive";
  const parts: Sql[] = [];

  for (const [op, opValue] of Object.entries(filter)) {
    if (op === "mode") continue;
    if (opValue === undefined) continue;
    parts.push(compileOperator(ref, op, opValue, insensitive, ctx));
  }
  if (parts.length === 0) return new Sql();
  return wrapAnd(parts);
}

function compileOperator(
  ref: string,
  op: string,
  value: unknown,
  insensitive: boolean,
  ctx: CompileContext,
): Sql {
  const d = ctx.dialect;
  const bound = (v: unknown) => d.coerceValue(v);
  const lhs = insensitive ? d.caseInsensitive(ref) : ref;
  const rhs = (v: unknown) =>
    insensitive && typeof v === "string"
      ? new Sql().push("UPPER(").bind(bound(v)).push(")")
      : Sql.value(bound(v));

  switch (op) {
    case "equals":
      if (value === null) return Sql.raw(`${ref} IS NULL`);
      return new Sql().push(`${lhs} = `).append(rhs(value));
    case "not":
      if (value === null) return Sql.raw(`${ref} IS NOT NULL`);
      if (isFilterObject(value)) {
        const inner = compileScalarFromRef(ref, value as ScalarFilter, insensitive, ctx);
        return new Sql().push("NOT (").append(inner).push(")");
      }
      return new Sql().push(`${lhs} <> `).append(rhs(value));
    case "in":
      return inClause(lhs, asUnknownArray(value), insensitive, ctx, false);
    case "notIn":
      return inClause(lhs, asUnknownArray(value), insensitive, ctx, true);
    case "lt":
      return new Sql().push(`${lhs} < `).append(rhs(value));
    case "lte":
      return new Sql().push(`${lhs} <= `).append(rhs(value));
    case "gt":
      return new Sql().push(`${lhs} > `).append(rhs(value));
    case "gte":
      return new Sql().push(`${lhs} >= `).append(rhs(value));
    case "contains":
      return likeClause(lhs, `%${escapeLike(String(value))}%`, insensitive);
    case "startsWith":
      return likeClause(lhs, `${escapeLike(String(value))}%`, insensitive);
    case "endsWith":
      return likeClause(lhs, `%${escapeLike(String(value))}`, insensitive);
    default:
      throw new QueryValidationError(`Unsupported filter operator '${op}'.`);
  }
}

function compileScalarFromRef(
  ref: string,
  filter: ScalarFilter,
  insensitive: boolean,
  ctx: CompileContext,
): Sql {
  const parts: Sql[] = [];
  for (const [op, opValue] of Object.entries(filter)) {
    if (op === "mode" || opValue === undefined) continue;
    parts.push(compileOperator(ref, op, opValue, insensitive, ctx));
  }
  return parts.length ? wrapAnd(parts) : new Sql();
}

function inClause(
  lhs: string,
  values: unknown[],
  insensitive: boolean,
  ctx: CompileContext,
  negate: boolean,
): Sql {
  if (values.length === 0) {
    // `IN ()` is invalid; emulate the empty-set semantics.
    return Sql.raw(negate ? "1 = 1" : "1 = 0");
  }
  const coerced = values.map((v) =>
    insensitive && typeof v === "string"
      ? String(v).toUpperCase()
      : ctx.dialect.coerceValue(v),
  );
  const sql = new Sql().push(`${lhs} ${negate ? "NOT IN" : "IN"} (`);
  sql.bindList(coerced);
  sql.push(")");
  return sql;
}

function likeClause(lhs: string, pattern: string, insensitive: boolean): Sql {
  const value = insensitive ? pattern.toUpperCase() : pattern;
  return new Sql().push(`${lhs} LIKE `).bind(value).push(" ESCAPE '\\'");
}

function compileRelationFilter(
  model: ModelNode,
  tableAlias: string,
  field: FieldNode,
  value: unknown,
  ctx: CompileContext,
): Sql {
  const rel = resolveRelation(ctx.schema, model, field);
  const filter = (isPlainObject(value) ? value : {}) as Record<string, WhereInput | null>;

  // To-one shorthand: `{ author: { name: "x" } }` behaves like `is`.
  const hasOperator =
    "some" in filter || "every" in filter || "none" in filter ||
    "is" in filter || "isNot" in filter;

  if (!rel.isList && !hasOperator) {
    return existsClause(model, tableAlias, rel, value as WhereInput, ctx, false);
  }

  const parts: Sql[] = [];
  if (filter.some !== undefined) {
    parts.push(existsClause(model, tableAlias, rel, filter.some ?? {}, ctx, false));
  }
  if (filter.none !== undefined) {
    parts.push(existsClause(model, tableAlias, rel, filter.none ?? {}, ctx, true));
  }
  if (filter.every !== undefined) {
    // NOT EXISTS (related WHERE join AND NOT (sub))
    parts.push(
      existsClause(model, tableAlias, rel, filter.every ?? {}, ctx, true, true),
    );
  }
  if (filter.is !== undefined) {
    if (filter.is === null) {
      parts.push(notExists(model, tableAlias, rel, {}, ctx));
    } else {
      parts.push(existsClause(model, tableAlias, rel, filter.is, ctx, false));
    }
  }
  if (filter.isNot !== undefined) {
    if (filter.isNot === null) {
      parts.push(existsClause(model, tableAlias, rel, {}, ctx, false));
    } else {
      parts.push(existsClause(model, tableAlias, rel, filter.isNot, ctx, true));
    }
  }
  return parts.length ? wrapAnd(parts) : new Sql();
}

function notExists(
  model: ModelNode,
  tableAlias: string,
  rel: ReturnType<typeof resolveRelation>,
  sub: WhereInput,
  ctx: CompileContext,
): Sql {
  return existsClause(model, tableAlias, rel, sub, ctx, true);
}

/**
 * Build `[NOT] EXISTS (SELECT 1 FROM related child WHERE join [AND sub])`.
 * When `everyMode` is set, the subfilter is negated to express `every`.
 */
function existsClause(
  _model: ModelNode,
  tableAlias: string,
  rel: ReturnType<typeof resolveRelation>,
  sub: WhereInput,
  ctx: CompileContext,
  negate: boolean,
  everyMode = false,
): Sql {
  const childAlias = `r${ctx.alias.next++}`;
  const childTable = ctx.dialect.quoteId(modelTable(rel.relatedModel));
  const sql = new Sql();
  sql.push(`${negate ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM ${childTable} ${ctx.dialect.quoteId(childAlias)} WHERE `);

  const joins = rel.fromColumns.map((fromCol, i) => {
    const toCol = rel.toColumns[i]!;
    return `${ctx.dialect.quoteRef(childAlias, toCol)} = ${ctx.dialect.quoteRef(tableAlias, fromCol)}`;
  });
  sql.push(joins.join(" AND "));

  const subSql = compileWhere(rel.relatedModel, childAlias, sub, ctx);
  if (!subSql.isEmpty()) {
    if (everyMode) {
      sql.push(" AND NOT (").append(subSql).push(")");
    } else {
      sql.push(" AND ").append(subSql);
    }
  }
  sql.push(")");
  return sql;
}

// ---- helpers ------------------------------------------------------------

function isFilterObject(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((k) => SCALAR_OPERATORS.has(k));
}

function asArray(value: unknown): WhereInput[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (v): v is WhereInput => v !== null && typeof v === "object",
  );
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
