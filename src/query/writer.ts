import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  fieldColumn,
  idFields,
} from "@ember/ast";
import { QueryValidationError, RecordNotFoundError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import type { SqlValue } from "@ember/driver";
import { isPlainObject } from "@ember/utils";
import type { WhereInput } from "./args";
import {
  compileDelete,
  compileInsert,
  compileUpdate,
  newContext,
} from "./compiler";
import { type CompileContext, compileWhere } from "./where";
import {
  applyCreateDefaults,
  applyUpdateDefaults,
  isAutoincrement,
} from "./defaults";
import { resolveRelation, type ResolvedRelation } from "./relations";

export type Executor = (sql: Sql) => Promise<Record<string, unknown>[]>;

/**
 * Handles INSERT/UPDATE with nested relation writes (connect/create/disconnect/
 * set/delete). Owning-side relations are resolved before the row is written so
 * the foreign key is part of the INSERT; child-side relations are written after
 * the parent exists so their foreign keys can point back.
 *
 * All FK maps are keyed by *field name* when feeding the scalar pipeline and by
 * *column name* when feeding compileUpdate directly (which expects columns).
 */
export class WriteProcessor {
  constructor(
    private readonly schema: SchemaDocument,
    private readonly dialect: SqlDialect,
    private readonly exec: Executor,
  ) {}

  private ctx(): CompileContext {
    return newContext(this.schema, this.dialect);
  }

  /** Insert one row (with nested writes) and return its key values. */
  async create(
    model: ModelNode,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { scalars, owning, children } = this.partition(model, data);

    for (const [field, op] of owning) {
      for (const [fieldName, value] of await this.resolveOwning(model, field, op)) {
        scalars.set(fieldName, value);
      }
    }

    const withDefaults = applyCreateDefaults(model, recordOf(scalars));
    const row = this.toColumnMap(model, withDefaults);

    const returning = idFields(model);
    const stmt = compileInsert(model, row, this.ctx(), returning);
    const result = await this.exec(stmt.sql);
    const keys = this.keyValues(model, result[0] ?? {}, withDefaults);

    for (const [field, op] of children) {
      await this.writeChildren(model, keys, field, op);
    }
    return keys;
  }

  /** Update rows matched by `where` (with nested writes). */
  async updateRow(
    model: ModelNode,
    where: WhereInput,
    data: Record<string, unknown>,
    keys: Record<string, unknown>,
  ): Promise<void> {
    const { scalars, owning, children } = this.partition(model, data, true);

    for (const [field, op] of owning) {
      for (const [fieldName, value] of await this.resolveOwningForUpdate(
        model,
        field,
        op,
      )) {
        scalars.set(fieldName, value);
      }
    }

    const withDefaults = applyUpdateDefaults(model, recordOf(scalars));
    const assignments = this.toColumnMap(model, withDefaults);

    if (assignments.size > 0) {
      const stmt = compileUpdate(model, where, assignments, this.ctx());
      await this.exec(stmt.sql);
    }

    for (const [field, op] of children) {
      await this.writeChildren(model, keys, field, op);
    }
  }

  // ---- partition & mapping ------------------------------------------------

  private partition(
    model: ModelNode,
    data: Record<string, unknown>,
    isUpdate = false,
  ): {
    scalars: Map<string, unknown>;
    owning: [FieldNode, Record<string, unknown>][];
    children: [FieldNode, Record<string, unknown>][];
  } {
    const scalars = new Map<string, unknown>();
    const owning: [FieldNode, Record<string, unknown>][] = [];
    const children: [FieldNode, Record<string, unknown>][] = [];

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const field = model.fields.find((f) => f.name === key);
      if (!field) {
        throw new QueryValidationError(
          `Unknown field '${key}' on model '${model.name}'.`,
        );
      }
      if (field.kind !== "object") {
        scalars.set(key, isUpdate ? unwrapUpdateScalar(value) : value);
        continue;
      }
      if (!isPlainObject(value)) {
        throw new QueryValidationError(
          `Relation '${model.name}.${key}' expects a nested write object.`,
        );
      }
      const rel = resolveRelation(this.schema, model, field);
      if (rel.owns) owning.push([field, value]);
      else children.push([field, value]);
    }
    return { scalars, owning, children };
  }

  private toColumnMap(
    model: ModelNode,
    record: Record<string, unknown>,
  ): Map<string, SqlValue> {
    const out = new Map<string, SqlValue>();
    for (const [name, value] of Object.entries(record)) {
      const field = model.fields.find((f) => f.name === name);
      if (!field || field.kind === "object") continue;
      if (isAutoincrement(field) && (value === undefined || value === null)) {
        continue;
      }
      out.set(fieldColumn(field), this.dialect.coerceValue(value));
    }
    return out;
  }

  private keyValues(
    model: ModelNode,
    returnedRow: Record<string, unknown>,
    writtenData: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of idFields(model)) {
      out[f.name] =
        returnedRow[f.name] ??
        returnedRow[fieldColumn(f)] ??
        writtenData[f.name];
    }
    return out;
  }

  // ---- owning-side relations ---------------------------------------------

  private async resolveOwning(
    model: ModelNode,
    field: FieldNode,
    op: Record<string, unknown>,
  ): Promise<[string, SqlValue][]> {
    const rel = resolveRelation(this.schema, model, field);
    if (op.connect) {
      const ref = await this.lookupReference(rel, op.connect as WhereInput);
      return this.mapFkByField(rel, ref);
    }
    if (op.create) {
      const childKeys = await this.create(
        rel.relatedModel,
        op.create as Record<string, unknown>,
      );
      return this.mapFkByField(rel, childKeys);
    }
    if (op.connectOrCreate) {
      const spec = op.connectOrCreate as {
        where: WhereInput;
        create: Record<string, unknown>;
      };
      const existing = await this.tryLookupReference(rel, spec.where);
      const ref = existing ?? (await this.create(rel.relatedModel, spec.create));
      return this.mapFkByField(rel, ref);
    }
    throw new QueryValidationError(
      `Unsupported nested write on '${model.name}.${field.name}'.`,
    );
  }

  private async resolveOwningForUpdate(
    model: ModelNode,
    field: FieldNode,
    op: Record<string, unknown>,
  ): Promise<[string, SqlValue][]> {
    if (op.disconnect) {
      const rel = resolveRelation(this.schema, model, field);
      return rel.fromFields.map((name) => [name, null] as [string, SqlValue]);
    }
    return this.resolveOwning(model, field, op);
  }

  /** [localFieldName, value] pairs from the referenced model's key values. */
  private mapFkByField(
    rel: ResolvedRelation,
    refValues: Record<string, unknown>,
  ): [string, SqlValue][] {
    return rel.fromFields.map((fromField, i) => {
      const toField = rel.toFields[i]!;
      return [fromField, this.dialect.coerceValue(refValues[toField] ?? null)];
    });
  }

  private async lookupReference(
    rel: ResolvedRelation,
    where: WhereInput,
  ): Promise<Record<string, unknown>> {
    const found = await this.tryLookupReference(rel, where);
    if (!found) throw new RecordNotFoundError(rel.relatedModel.name);
    return found;
  }

  private async tryLookupReference(
    rel: ResolvedRelation,
    where: WhereInput,
  ): Promise<Record<string, unknown> | null> {
    const fields = rel.toFields.map((n) => requireField(rel.relatedModel, n));
    const stmt = this.selectKeys(rel.relatedModel, fields, where);
    const rows = await this.exec(stmt);
    return rows[0] ?? null;
  }

  private selectKeys(
    model: ModelNode,
    fields: FieldNode[],
    where: WhereInput,
  ): Sql {
    const d = this.dialect;
    const alias = "t0";
    const sql = new Sql();
    sql.push("SELECT FIRST 1 ");
    sql.push(
      fields
        .map((f) => `${d.quoteRef(alias, fieldColumn(f))} AS ${d.quoteId(f.name)}`)
        .join(", "),
    );
    sql.push(` FROM ${d.quoteId(model.dbName ?? model.name)} ${d.quoteId(alias)}`);
    const cond = compileWhere(model, alias, where, this.ctx());
    if (!cond.isEmpty()) sql.push(" WHERE ").append(cond);
    return sql;
  }

  // ---- child-side relations ----------------------------------------------

  private async writeChildren(
    parentModel: ModelNode,
    parentKeys: Record<string, unknown>,
    field: FieldNode,
    op: Record<string, unknown>,
  ): Promise<void> {
    const rel = resolveRelation(this.schema, parentModel, field);
    const fkColumns: [string, SqlValue][] = rel.toColumns.map((toCol, i) => {
      const fromField = rel.fromFields[i]!;
      return [toCol, this.dialect.coerceValue(parentKeys[fromField] ?? null)];
    });

    for (const childData of toArray(op.create)) {
      await this.create(rel.relatedModel, { ...childData, ...fkRecord(rel, parentKeys) });
    }
    for (const where of toArray(op.connect)) {
      await this.setChildForeignKey(rel, where as WhereInput, fkColumns);
    }
    if (op.set !== undefined) {
      await this.clearChildren(rel, parentKeys);
      for (const where of toArray(op.set)) {
        await this.setChildForeignKey(rel, where as WhereInput, fkColumns);
      }
    }
    for (const where of toArray(op.disconnect)) {
      await this.setChildForeignKey(
        rel,
        where as WhereInput,
        rel.toColumns.map((c) => [c, null] as [string, SqlValue]),
      );
    }
    for (const where of toArray(op.delete)) {
      const stmt = compileDelete(rel.relatedModel, where as WhereInput, this.ctx());
      await this.exec(stmt.sql);
    }
  }

  private async setChildForeignKey(
    rel: ResolvedRelation,
    where: WhereInput,
    fkColumns: [string, SqlValue][],
  ): Promise<void> {
    const assignments = new Map<string, SqlValue>(fkColumns);
    const stmt = compileUpdate(rel.relatedModel, where, assignments, this.ctx());
    await this.exec(stmt.sql);
  }

  private async clearChildren(
    rel: ResolvedRelation,
    parentKeys: Record<string, unknown>,
  ): Promise<void> {
    const matchWhere: WhereInput = {};
    rel.toFields.forEach((toField, i) => {
      const fromField = rel.fromFields[i]!;
      matchWhere[toField] = parentKeys[fromField];
    });
    const assignments = new Map<string, SqlValue>(
      rel.toColumns.map((c) => [c, null] as [string, SqlValue]),
    );
    const stmt = compileUpdate(rel.relatedModel, matchWhere, assignments, this.ctx());
    await this.exec(stmt.sql);
  }
}

// ---- helpers --------------------------------------------------------------

function requireField(model: ModelNode, name: string): FieldNode {
  const f = model.fields.find((x) => x.name === name);
  if (!f) {
    throw new QueryValidationError(`Field '${name}' not found on '${model.name}'.`);
  }
  return f;
}

function fkRecord(
  rel: ResolvedRelation,
  parentKeys: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  rel.toFields.forEach((toField, i) => {
    const fromField = rel.fromFields[i]!;
    out[toField] = parentKeys[fromField];
  });
  return out;
}

function recordOf(scalars: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of scalars) out[k] = v;
  return out;
}

/** Unwrap `{ set: x }` scalar update operations to a direct value. */
function unwrapUpdateScalar(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if ("set" in value) return value.set;
  return value;
}

function toArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}
