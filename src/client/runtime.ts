import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  findModel,
  relationFields,
} from "@ember/ast";
import type { QueryEngine } from "@ember/query";

/**
 * Client Extensions ($extends), middleware ($use) and the fluent API live here.
 * The delegate factory composes per-operation query hooks, computes `result`
 * fields, and returns fluent thenables for single-record reads.
 */

export interface ResultFieldExtension {
  needs?: Record<string, boolean>;
  compute: (record: Record<string, unknown>) => unknown;
}

export interface QueryHookParams {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}

export type QueryHook = (params: QueryHookParams) => Promise<unknown>;

type HookMap = Record<string, QueryHook>;

export interface EmberExtensionArgs {
  name?: string;
  result?: Record<string, Record<string, ResultFieldExtension>>;
  model?: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  query?: Record<string, HookMap>;
  client?: Record<string, unknown>;
}

/** Prisma-style middleware: `(params, next) => next(params)`. */
export type Middleware = (
  params: { model?: string; action: string; args: unknown },
  next: (params: { model?: string; action: string; args: unknown }) => Promise<unknown>,
) => Promise<unknown>;

/** Operations whose result is one or more records of the delegate's model. */
const RECORD_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createManyAndReturn",
  "update",
  "upsert",
  "delete",
]);

const ALL_OPS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

const FLUENT_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
]);

export interface DelegateContext {
  engine: QueryEngine;
  schema: SchemaDocument;
  extensions: EmberExtensionArgs[];
  middlewares: Middleware[];
}

/** Build a model delegate with extensions, middleware and fluent reads applied. */
export function buildDelegate(
  ctx: DelegateContext,
  modelName: string,
): Record<string, unknown> {
  const model = findModel(ctx.schema, modelName);
  const delegate: Record<string, unknown> = {};

  for (const operation of ALL_OPS) {
    delegate[operation] = (args: Record<string, unknown> = {}) =>
      runOperation(ctx, modelName, operation, args, delegate);
  }

  // model extensions add/override delegate methods (bound to the delegate).
  for (const ext of ctx.extensions) {
    const methods = {
      ...(ext.model?.$allModels ?? {}),
      ...(ext.model?.[modelName] ?? {}),
    };
    for (const [name, fn] of Object.entries(methods)) {
      delegate[name] = (...args: unknown[]) => fn.apply(delegate, args);
    }
  }

  void model;
  return delegate;
}

function runOperation(
  ctx: DelegateContext,
  modelName: string,
  operation: string,
  args: Record<string, unknown>,
  delegate: Record<string, unknown>,
): unknown {
  // The core executor: middleware -> engine, then compute result fields.
  const base = async (a: Record<string, unknown>): Promise<unknown> => {
    const expanded = expandComputedSelect(ctx, modelName, operation, a);
    const raw = await runMiddleware(ctx, modelName, operation, expanded.args);
    return applyResultExtensions(ctx, modelName, operation, raw, expanded.computeOnly);
  };

  const hooks = gatherQueryHooks(ctx, modelName, operation);
  const run = composeHooks(hooks, modelName, operation, base);

  if (FLUENT_OPS.has(operation)) {
    return makeFluent(ctx, modelName, args, () => run(args) as Promise<Record<string, unknown> | null>);
  }
  void delegate;
  return run(args);
}

// ---- query hooks ($extends.query) -----------------------------------------

function gatherQueryHooks(
  ctx: DelegateContext,
  model: string,
  operation: string,
): QueryHook[] {
  const hooks: QueryHook[] = [];
  for (const ext of ctx.extensions) {
    const q = ext.query;
    if (!q) continue;
    pushHook(hooks, q[model], operation);
    pushHook(hooks, q.$allModels, operation);
  }
  return hooks;
}

function pushHook(hooks: QueryHook[], map: HookMap | undefined, operation: string): void {
  if (!map) return;
  if (map[operation]) hooks.push(map[operation]!);
  if (map.$allOperations) hooks.push(map.$allOperations);
}

function composeHooks(
  hooks: QueryHook[],
  model: string,
  operation: string,
  base: (args: Record<string, unknown>) => Promise<unknown>,
): (args: Record<string, unknown>) => Promise<unknown> {
  // Later-registered hooks wrap earlier ones (outermost = last registered).
  let next = base;
  for (const hook of hooks) {
    const inner = next;
    next = (args: Record<string, unknown>) =>
      hook({ model, operation, args, query: (a) => inner(a) }) as Promise<unknown>;
  }
  return next;
}

// ---- middleware ($use) ----------------------------------------------------

function runMiddleware(
  ctx: DelegateContext,
  model: string,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const engine = ctx.engine as unknown as Record<
    string,
    (m: string, x: unknown) => Promise<unknown>
  >;
  const engineCall = (a: { model?: string; action: string; args: unknown }) =>
    engine[a.action]!(model, a.args);

  let next = engineCall;
  for (const mw of ctx.middlewares) {
    const inner = next;
    next = (params) => mw(params, inner) as Promise<unknown>;
  }
  return next({ model, action, args });
}

// ---- result extensions ($extends.result) ----------------------------------

interface ResultComputer {
  field: string;
  compute: (record: Record<string, unknown>) => unknown;
}

function resultComputers(ctx: DelegateContext, model: string): ResultComputer[] {
  const out: ResultComputer[] = [];
  for (const ext of ctx.extensions) {
    const r = ext.result?.[model];
    if (!r) continue;
    for (const [field, def] of Object.entries(r)) {
      out.push({ field, compute: def.compute });
    }
  }
  return out;
}

function applyResultExtensions(
  ctx: DelegateContext,
  model: string,
  operation: string,
  value: unknown,
  computeFields: Set<string> | null,
): unknown {
  if (!RECORD_OPS.has(operation)) return value;
  const computers = resultComputers(ctx, model).filter(
    (c) => !computeFields || computeFields.has(c.field),
  );
  if (computers.length === 0) return value;

  const compute = (rec: unknown): unknown => {
    if (!rec || typeof rec !== "object") return rec;
    const record = rec as Record<string, unknown>;
    for (const c of computers) {
      try {
        record[c.field] = c.compute(record);
      } catch {
        /* leave field unset if compute throws (e.g. missing `needs`) */
      }
    }
    return record;
  };

  return Array.isArray(value) ? value.map(compute) : compute(value);
}

/**
 * When `select` references a computed result field, replace it with the
 * field's `needs` (real columns) so the engine can fetch them, and remember to
 * compute only the requested computed fields.
 */
function expandComputedSelect(
  ctx: DelegateContext,
  model: string,
  operation: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; computeOnly: Set<string> | null } {
  const computers = resultComputers(ctx, model);
  if (computers.length === 0) return { args, computeOnly: null };

  const select = args.select as Record<string, unknown> | undefined;
  if (!select) return { args, computeOnly: null };

  const byField = new Map(
    ctx.extensions
      .flatMap((e) => Object.entries(e.result?.[model] ?? {}))
      .map(([f, def]) => [f, def] as const),
  );

  const computeOnly = new Set<string>();
  const newSelect: Record<string, unknown> = { ...select };
  for (const key of Object.keys(select)) {
    const def = byField.get(key);
    if (!def) continue;
    computeOnly.add(key);
    delete newSelect[key];
    for (const need of Object.keys(def.needs ?? {})) newSelect[need] = true;
  }
  if (computeOnly.size === 0) return { args, computeOnly: null };
  return { args: { ...args, select: newSelect }, computeOnly };
}

// ---- fluent API -----------------------------------------------------------

interface Fluent {
  then: Promise<unknown>["then"];
  catch: Promise<unknown>["catch"];
  finally: Promise<unknown>["finally"];
  [relation: string]: unknown;
}

function makeFluent(
  ctx: DelegateContext,
  modelName: string,
  args: Record<string, unknown>,
  exec: () => Promise<Record<string, unknown> | null>,
): Fluent {
  const model = findModel(ctx.schema, modelName)!;
  const where = (args.where ?? {}) as Record<string, unknown>;

  let cached: Promise<unknown> | null = null;
  const run = () => (cached ??= exec());

  const fluent = {
    then: (res?: any, rej?: any) => run().then(res, rej),
    catch: (rej?: any) => run().catch(rej),
    finally: (f?: any) => run().finally(f),
  } as Fluent;

  for (const rel of relationFields(model)) {
    fluent[rel.name] = (subArgs: Record<string, unknown> = {}) =>
      traverse(ctx, model, rel, where, subArgs);
  }
  return fluent;
}

function traverse(
  ctx: DelegateContext,
  model: ModelNode,
  rel: FieldNode,
  parentWhere: Record<string, unknown>,
  subArgs: Record<string, unknown>,
): unknown {
  const inverse = inverseField(ctx.schema, model, rel);
  const relatedWhere: Record<string, unknown> = inverse
    ? inverse.isList
      ? { [inverse.name]: { some: parentWhere } }
      : { [inverse.name]: parentWhere }
    : {};
  const where: Record<string, unknown> = subArgs.where
    ? { AND: [relatedWhere, subArgs.where] }
    : relatedWhere;

  const findArgs = { ...subArgs, where } as Record<string, unknown> as never;
  if (rel.isList) {
    return ctx.engine.findMany(rel.type, findArgs);
  }
  // to-one target: chainable fluent
  return makeFluent(ctx, rel.type, { ...subArgs, where }, () =>
    ctx.engine.findFirst(rel.type, findArgs),
  );
}

function inverseField(
  schema: SchemaDocument,
  model: ModelNode,
  rel: FieldNode,
): FieldNode | undefined {
  const related = findModel(schema, rel.type);
  if (!related) return undefined;
  const candidates = related.fields.filter(
    (f) => f.kind === "object" && f.type === model.name,
  );
  if (rel.relation?.name) {
    const byName = candidates.find((f) => f.relation?.name === rel.relation?.name);
    if (byName) return byName;
  }
  return candidates[0];
}
