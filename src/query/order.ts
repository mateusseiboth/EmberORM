import { type ModelNode, fieldColumn } from "@ember/ast";
import { QueryValidationError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import type { OrderByInput, SortOrder } from "./args";

/**
 * Compile an `orderBy` argument into an `ORDER BY` fragment (without the
 * keyword). Accepts a single object or an ordered array of single-key objects,
 * matching Prisma's deterministic ordering semantics.
 */
export function compileOrderBy(
  model: ModelNode,
  tableAlias: string,
  orderBy: OrderByInput | undefined,
  dialect: SqlDialect,
): Sql {
  if (!orderBy) return new Sql();
  const entries = normalize(orderBy);
  if (entries.length === 0) return new Sql();

  const parts = entries.map(([fieldName, dir]) => {
    const field = model.fields.find((f) => f.name === fieldName);
    if (!field || field.kind === "object") {
      throw new QueryValidationError(
        `Cannot order '${model.name}' by '${fieldName}'.`,
      );
    }
    const ref = dialect.quoteRef(tableAlias, fieldColumn(field));
    return Sql.raw(`${ref} ${dir === "desc" ? "DESC" : "ASC"}`);
  });

  return Sql.join(parts, ", ");
}

function normalize(orderBy: OrderByInput): [string, SortOrder][] {
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: [string, SortOrder][] = [];
  for (const obj of list) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === "asc" || value === "desc") out.push([key, value]);
    }
  }
  return out;
}
