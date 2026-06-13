import type { QueryEngine } from "@ember/query";
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
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from "@ember/query";

/**
 * The full set of operations exposed on `client.<model>`. The generated client
 * narrows every argument and return type per model; this is the untyped runtime
 * surface they share.
 */
export interface ModelDelegate {
  findMany(args?: FindManyArgs): Promise<Record<string, unknown>[]>;
  findFirst(args?: FindFirstArgs): Promise<Record<string, unknown> | null>;
  findFirstOrThrow(args?: FindFirstArgs): Promise<Record<string, unknown>>;
  findUnique(args: FindUniqueArgs): Promise<Record<string, unknown> | null>;
  findUniqueOrThrow(args: FindUniqueArgs): Promise<Record<string, unknown>>;
  create(args: CreateArgs): Promise<Record<string, unknown>>;
  createMany(args: CreateManyArgs): Promise<{ count: number }>;
  update(args: UpdateArgs): Promise<Record<string, unknown>>;
  updateMany(args: UpdateManyArgs): Promise<{ count: number }>;
  upsert(args: UpsertArgs): Promise<Record<string, unknown>>;
  delete(args: DeleteArgs): Promise<Record<string, unknown>>;
  deleteMany(args?: DeleteManyArgs): Promise<{ count: number }>;
  count(args?: CountArgs): Promise<number>;
  aggregate(args?: AggregateArgs): Promise<Record<string, unknown>>;
  groupBy(args: GroupByArgs): Promise<Record<string, unknown>[]>;
}

/** Build a delegate bound to `modelName`, forwarding to the engine. */
export function createDelegate(
  engine: QueryEngine,
  modelName: string,
): ModelDelegate {
  return {
    findMany: (args = {}) => engine.findMany(modelName, args),
    findFirst: (args = {}) => engine.findFirst(modelName, args),
    findFirstOrThrow: (args = {}) => engine.findFirstOrThrow(modelName, args),
    findUnique: (args) => engine.findUnique(modelName, args),
    findUniqueOrThrow: (args) => engine.findUniqueOrThrow(modelName, args),
    create: (args) => engine.create(modelName, args),
    createMany: (args) => engine.createMany(modelName, args),
    update: (args) => engine.update(modelName, args),
    updateMany: (args) => engine.updateMany(modelName, args),
    upsert: (args) => engine.upsert(modelName, args),
    delete: (args) => engine.delete(modelName, args),
    deleteMany: (args = {}) => engine.deleteMany(modelName, args),
    count: (args = {}) => engine.count(modelName, args),
    aggregate: (args = {}) => engine.aggregate(modelName, args),
    groupBy: (args) => engine.groupBy(modelName, args),
  };
}
