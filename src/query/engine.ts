import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  findModel,
  idFields,
  scalarFields,
} from "@ember/ast";
import {
  type SqlDriver,
  type TransactionContext,
  type TransactionOptions,
} from "@ember/driver";
import { QueryValidationError, RecordNotFoundError } from "@ember/errors";
import { Sql, type SqlDialect } from "@ember/sql";
import { uniq } from "@ember/utils";
import type {
  AggregateArgs,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindFirstArgs,
  FindManyArgs,
  FindUniqueArgs,
  GroupByArgs,
  IncludeInput,
  NestedReadArgs,
  SelectInput,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  WhereInput,
} from "./args";
import {
  compileAggregate,
  compileCount,
  compileDelete,
  compileFindMany,
  compileGroupBy,
  newContext,
} from "./compiler";
import { coerceRow } from "./coerce";
import { resolveRelation } from "./relations";
import { WriteProcessor, type Executor } from "./writer";

interface RelationRead {
  field: FieldNode;
  args: NestedReadArgs;
}

/**
 * The query engine executes high-level operations against a driver. Reads use
 * a projection + relation-stitching pipeline (relations are loaded with
 * separate batched queries, Prisma-style). Writes are delegated to
 * WriteProcessor. Every operation runs inside a driver transaction.
 */
export class QueryEngine {
  constructor(
    private readonly schema: SchemaDocument,
    private readonly dialect: SqlDialect,
    private readonly driver: SqlDriver,
  ) {}

  model(name: string): ModelNode {
    const model = findModel(this.schema, name);
    if (!model) throw new QueryValidationError(`Unknown model '${name}'.`);
    return model;
  }

  private run<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.driver.transaction(fn, options);
  }

  private execOn(tx: TransactionContext): Executor {
    return (sql: Sql) => tx.query(sql.text, sql.params);
  }

  // ---- reads --------------------------------------------------------------

  findMany(name: string, args: FindManyArgs = {}): Promise<Record<string, unknown>[]> {
    const model = this.model(name);
    return this.run((tx) => this.readMany(model, args, this.execOn(tx)));
  }

  async findFirst(
    name: string,
    args: FindFirstArgs = {},
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.findMany(name, { ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findFirstOrThrow(name: string, args: FindFirstArgs = {}) {
    const row = await this.findFirst(name, args);
    if (!row) throw new RecordNotFoundError(name);
    return row;
  }

  async findUnique(
    name: string,
    args: FindUniqueArgs,
  ): Promise<Record<string, unknown> | null> {
    const model = this.model(name);
    this.assertUniqueWhere(model, args.where);
    const rows = await this.run((tx) =>
      this.readMany(
        model,
        { where: args.where, select: args.select, include: args.include, take: 1 },
        this.execOn(tx),
      ),
    );
    return rows[0] ?? null;
  }

  async findUniqueOrThrow(name: string, args: FindUniqueArgs) {
    const row = await this.findUnique(name, args);
    if (!row) throw new RecordNotFoundError(name);
    return row;
  }

  // ---- aggregations -------------------------------------------------------

  count(name: string, args: CountArgs = {}): Promise<number> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const stmt = compileCount(model, args.where, newContext(this.schema, this.dialect), {
        take: args.take,
        skip: args.skip,
      });
      const rows = await tx.query<{ _count: unknown }>(stmt.text, stmt.params);
      return Number(rows[0]?._count ?? 0);
    });
  }

  aggregate(name: string, args: AggregateArgs = {}): Promise<Record<string, unknown>> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const stmt = compileAggregate(model, args, newContext(this.schema, this.dialect));
      const rows = await tx.query<Record<string, unknown>>(stmt.text, stmt.params);
      return reshapeAggregate(rows[0] ?? {});
    });
  }

  groupBy(name: string, args: GroupByArgs): Promise<Record<string, unknown>[]> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const { sql } = compileGroupBy(model, args, newContext(this.schema, this.dialect));
      const rows = await tx.query<Record<string, unknown>>(sql.text, sql.params);
      return rows.map((r) => reshapeGroupRow(model, args.by, r));
    });
  }

  // ---- writes -------------------------------------------------------------

  create(name: string, args: CreateArgs): Promise<Record<string, unknown>> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const writer = new WriteProcessor(this.schema, this.dialect, this.execOn(tx));
      const keys = await writer.create(model, args.data);
      return this.readBack(model, keys, args.select, args.include, this.execOn(tx));
    });
  }

  createMany(name: string, args: CreateManyArgs): Promise<{ count: number }> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const writer = new WriteProcessor(this.schema, this.dialect, this.execOn(tx));
      let count = 0;
      for (const data of args.data) {
        await writer.create(model, data);
        count++;
      }
      return { count };
    });
  }

  update(name: string, args: UpdateArgs): Promise<Record<string, unknown>> {
    const model = this.model(name);
    this.assertUniqueWhere(model, args.where);
    return this.run(async (tx) => {
      const exec = this.execOn(tx);
      const target = await this.requireOne(model, args.where, exec);
      const keys = this.pickKeys(model, target);
      const writer = new WriteProcessor(this.schema, this.dialect, exec);
      await writer.updateRow(model, args.where, args.data, keys);
      return this.readBack(model, keys, args.select, args.include, exec);
    });
  }

  updateMany(name: string, args: UpdateManyArgs): Promise<{ count: number }> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const exec = this.execOn(tx);
      const count = await this.countMatching(model, args.where, exec);
      const writer = new WriteProcessor(this.schema, this.dialect, exec);
      // updateMany only sets scalar fields; apply to the whole matched set.
      await writer.updateRow(model, args.where ?? {}, args.data, {});
      return { count };
    });
  }

  upsert(name: string, args: UpsertArgs): Promise<Record<string, unknown>> {
    const model = this.model(name);
    this.assertUniqueWhere(model, args.where);
    return this.run(async (tx) => {
      const exec = this.execOn(tx);
      const existing = await this.findOneRaw(model, args.where, exec);
      const writer = new WriteProcessor(this.schema, this.dialect, exec);
      if (existing) {
        const keys = this.pickKeys(model, existing);
        await writer.updateRow(model, args.where, args.update, keys);
        return this.readBack(model, keys, args.select, args.include, exec);
      }
      const keys = await writer.create(model, args.create);
      return this.readBack(model, keys, args.select, args.include, exec);
    });
  }

  delete(name: string, args: DeleteArgs): Promise<Record<string, unknown>> {
    const model = this.model(name);
    this.assertUniqueWhere(model, args.where);
    return this.run(async (tx) => {
      const exec = this.execOn(tx);
      const row = await this.readBackOne(model, args.where, args.select, args.include, exec);
      if (!row) throw new RecordNotFoundError(name);
      const stmt = compileDelete(model, args.where, newContext(this.schema, this.dialect));
      await exec(stmt.sql);
      return row;
    });
  }

  deleteMany(name: string, args: DeleteManyArgs = {}): Promise<{ count: number }> {
    const model = this.model(name);
    return this.run(async (tx) => {
      const exec = this.execOn(tx);
      const count = await this.countMatching(model, args.where, exec);
      const stmt = compileDelete(model, args.where, newContext(this.schema, this.dialect));
      await exec(stmt.sql);
      return { count };
    });
  }

  // ---- read pipeline ------------------------------------------------------

  private async readMany(
    model: ModelNode,
    args: FindManyArgs,
    exec: Executor,
    forceKeep: string[] = [],
  ): Promise<Record<string, unknown>[]> {
    const relations = this.readRelations(model, args.select, args.include);
    const selectedScalars = selectedScalarNames(model, args.select);
    const relationKeyFields = uniq(
      relations.flatMap((r) => resolveRelation(this.schema, model, r.field).fromFields),
    );
    const projectionNames = uniq([
      ...(selectedScalars ?? scalarFields(model).map((f) => f.name)),
      ...relationKeyFields,
      ...forceKeep,
    ]);
    const projection = projectionNames.map((n) => fieldByName(model, n));

    const stmt = compileFindMany(
      model,
      { where: args.where, orderBy: args.orderBy, take: args.take, skip: args.skip },
      projection,
      newContext(this.schema, this.dialect),
    );
    const rawRows = await exec(stmt.sql);
    const rows = rawRows.map((r) => coerceRow(r, projection));

    for (const relation of relations) {
      await this.loadRelation(model, rows, relation, exec);
    }

    // Strip internal scalar keys added only for stitching.
    if (selectedScalars) {
      const visible = new Set([...selectedScalars, ...forceKeep]);
      for (const row of rows) {
        for (const name of relationKeyFields) {
          if (!visible.has(name)) delete row[name];
        }
      }
    }
    return rows;
  }

  private async loadRelation(
    parentModel: ModelNode,
    parentRows: Record<string, unknown>[],
    relation: RelationRead,
    exec: Executor,
  ): Promise<void> {
    if (parentRows.length === 0) return;
    const rel = resolveRelation(this.schema, parentModel, relation.field);
    const fieldName = relation.field.name;

    // Single-column key fast path (the common case).
    if (rel.fromFields.length !== 1) {
      throw new QueryValidationError(
        `Composite-key relations are not yet supported for include ('${fieldName}').`,
      );
    }
    const fromField = rel.fromFields[0]!;
    const toField = rel.toFields[0]!;
    const keyValues = uniq(
      parentRows
        .map((r) => r[fromField])
        .filter((v) => v !== null && v !== undefined),
    );

    const grouped = new Map<string, Record<string, unknown>[]>();
    if (keyValues.length > 0) {
      const childWhere: WhereInput = {
        ...(relation.args.where ?? {}),
        [toField]: { in: keyValues },
      };
      const childRows = await this.readMany(
        rel.relatedModel,
        {
          where: childWhere,
          orderBy: relation.args.orderBy,
          select: relation.args.select,
          include: relation.args.include,
          // take/skip on to-many are applied per parent below; skip here.
          ...(rel.isList ? {} : { take: relation.args.take, skip: relation.args.skip }),
        },
        exec,
        [toField],
      );
      for (const child of childRows) {
        const k = keyOf(child[toField]);
        const list = grouped.get(k) ?? [];
        list.push(child);
        grouped.set(k, list);
      }
    }

    const stripToField = (() => {
      const visible = selectedScalarNames(rel.relatedModel, relation.args.select);
      return visible ? !visible.has(toField) : false;
    })();

    for (const parent of parentRows) {
      const k = keyOf(parent[fromField]);
      let matches = grouped.get(k) ?? [];
      if (rel.isList && (relation.args.take != null || relation.args.skip != null)) {
        matches = applyPagination(matches, relation.args.take, relation.args.skip);
      }
      const attached = stripToField
        ? matches.map((m) => omit(m, toField))
        : matches;
      parent[fieldName] = rel.isList ? attached : (attached[0] ?? null);
    }
  }

  private readRelations(
    model: ModelNode,
    select?: SelectInput,
    include?: IncludeInput,
  ): RelationRead[] {
    const out: RelationRead[] = [];
    const add = (key: string, value: boolean | NestedReadArgs) => {
      if (!value) return;
      const field = model.fields.find((f) => f.name === key && f.kind === "object");
      if (!field) return;
      out.push({ field, args: typeof value === "object" ? value : {} });
    };
    if (include) for (const [k, v] of Object.entries(include)) add(k, v);
    if (select) {
      for (const [k, v] of Object.entries(select)) {
        const field = model.fields.find((f) => f.name === k);
        if (field?.kind === "object") add(k, v);
      }
    }
    return out;
  }

  // ---- read-back & helpers ------------------------------------------------

  private async readBack(
    model: ModelNode,
    keys: Record<string, unknown>,
    select: SelectInput | undefined,
    include: IncludeInput | undefined,
    exec: Executor,
  ): Promise<Record<string, unknown>> {
    const where = keysToWhere(model, keys);
    const row = await this.readBackOne(model, where, select, include, exec);
    if (!row) throw new RecordNotFoundError(model.name);
    return row;
  }

  private async readBackOne(
    model: ModelNode,
    where: WhereInput,
    select: SelectInput | undefined,
    include: IncludeInput | undefined,
    exec: Executor,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.readMany(model, { where, select, include, take: 1 }, exec);
    return rows[0] ?? null;
  }

  private async requireOne(
    model: ModelNode,
    where: WhereInput,
    exec: Executor,
  ): Promise<Record<string, unknown>> {
    const row = await this.findOneRaw(model, where, exec);
    if (!row) throw new RecordNotFoundError(model.name);
    return row;
  }

  private async findOneRaw(
    model: ModelNode,
    where: WhereInput,
    exec: Executor,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.readMany(model, { where, take: 1 }, exec);
    return rows[0] ?? null;
  }

  private async countMatching(
    model: ModelNode,
    where: WhereInput | undefined,
    exec: Executor,
  ): Promise<number> {
    const stmt = compileCount(model, where, newContext(this.schema, this.dialect));
    const rows = await exec(stmt);
    return Number((rows[0] as { _count?: unknown })?._count ?? 0);
  }

  private pickKeys(
    model: ModelNode,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of idFields(model)) out[f.name] = row[f.name];
    return out;
  }

  private assertUniqueWhere(model: ModelNode, where: WhereInput): void {
    if (!where || Object.keys(where).length === 0) {
      throw new QueryValidationError(
        `A unique 'where' is required for this operation on '${model.name}'.`,
      );
    }
  }
}

// ---- pure helpers ---------------------------------------------------------

function fieldByName(model: ModelNode, name: string): FieldNode {
  const f = model.fields.find((x) => x.name === name);
  if (!f) throw new QueryValidationError(`Field '${name}' not found on '${model.name}'.`);
  return f;
}

function selectedScalarNames(
  model: ModelNode,
  select?: SelectInput,
): Set<string> | null {
  if (!select) return null;
  const names = new Set<string>();
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    const field = model.fields.find((f) => f.name === k);
    if (field && field.kind !== "object") names.add(k);
  }
  return names;
}

function keysToWhere(
  model: ModelNode,
  keys: Record<string, unknown>,
): WhereInput {
  const where: WhereInput = {};
  for (const f of idFields(model)) where[f.name] = keys[f.name];
  return where;
}

function keyOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function omit(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}

function applyPagination(
  rows: Record<string, unknown>[],
  take?: number,
  skip?: number,
): Record<string, unknown>[] {
  const start = skip ?? 0;
  const end = take != null ? start + take : undefined;
  return rows.slice(start, end);
}

function reshapeAggregate(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "_count_all") {
      (out._count ??= {} as Record<string, unknown>);
      (out._count as Record<string, unknown>)._all = Number(value);
      continue;
    }
    const m = /^(_count|_sum|_avg|_min|_max)_(.+)$/.exec(key);
    if (m) {
      const group = (out[m[1]!] ??= {}) as Record<string, unknown>;
      group[m[2]!] = value === null ? null : Number(value);
    }
  }
  return out;
}

function reshapeGroupRow(
  model: ModelNode,
  by: string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const groupFields = scalarFields(model).filter((f) => by.includes(f.name));
  for (const f of groupFields) {
    out[f.name] = f.name in row ? coerceField(row[f.name], f) : row[f.name];
  }
  const aggregates = reshapeAggregate(row);
  return { ...out, ...aggregates };
}

function coerceField(value: unknown, field: FieldNode): unknown {
  return coerceRow({ [field.name]: value }, [field])[field.name];
}
