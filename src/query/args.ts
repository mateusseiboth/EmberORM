/**
 * Runtime-facing query argument shapes. The generated client produces strict,
 * per-model versions of these; at runtime the engine works with these generic
 * forms. Mirrors Prisma's query API surface.
 */

export type SortOrder = "asc" | "desc";
export type QueryMode = "default" | "insensitive";

/** Scalar field filter, e.g. `{ equals, in, lt, contains, ... }`. */
export interface ScalarFilter {
  equals?: unknown;
  not?: unknown | ScalarFilter;
  in?: unknown[];
  notIn?: unknown[];
  lt?: unknown;
  lte?: unknown;
  gt?: unknown;
  gte?: unknown;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  mode?: QueryMode;
}

/** Relation filter for to-one (`is`/`isNot`) and to-many (`some`/`every`/`none`). */
export interface RelationFilter {
  is?: WhereInput | null;
  isNot?: WhereInput | null;
  some?: WhereInput;
  every?: WhereInput;
  none?: WhereInput;
}

export interface WhereInput {
  AND?: WhereInput | WhereInput[];
  OR?: WhereInput[];
  NOT?: WhereInput | WhereInput[];
  [field: string]:
    | unknown
    | ScalarFilter
    | RelationFilter
    | WhereInput
    | WhereInput[]
    | undefined;
}

export type OrderByInput =
  | Record<string, SortOrder>
  | Record<string, SortOrder>[];

export type SelectInput = Record<string, boolean | NestedReadArgs>;
export type IncludeInput = Record<string, boolean | NestedReadArgs>;
/** Fields to exclude from the result (inverse of select). */
export type OmitInput = Record<string, boolean>;

export interface NestedReadArgs {
  select?: SelectInput;
  include?: IncludeInput;
  where?: WhereInput;
  orderBy?: OrderByInput;
  take?: number;
  skip?: number;
  distinct?: string[];
}

export interface FindManyArgs {
  where?: WhereInput;
  orderBy?: OrderByInput;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
  take?: number;
  skip?: number;
  cursor?: Record<string, unknown>;
  distinct?: string[];
}

export interface FindUniqueArgs {
  where: WhereInput;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
}

export interface FindFirstArgs extends FindManyArgs {}

export interface CreateArgs {
  data: Record<string, unknown>;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
}

export interface CreateManyArgs {
  data: Record<string, unknown>[];
  skipDuplicates?: boolean;
}

export interface CreateManyAndReturnArgs {
  data: Record<string, unknown>[];
  select?: SelectInput;
  omit?: OmitInput;
  skipDuplicates?: boolean;
}

export interface UpdateArgs {
  where: WhereInput;
  data: Record<string, unknown>;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
}

export interface UpdateManyArgs {
  where?: WhereInput;
  data: Record<string, unknown>;
}

export interface UpsertArgs {
  where: WhereInput;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
}

export interface DeleteArgs {
  where: WhereInput;
  select?: SelectInput;
  include?: IncludeInput;
  omit?: OmitInput;
}

export interface DeleteManyArgs {
  where?: WhereInput;
}

export interface CountArgs {
  where?: WhereInput;
  take?: number;
  skip?: number;
  select?: Record<string, boolean> | true;
}

export interface AggregateArgs {
  where?: WhereInput;
  orderBy?: OrderByInput;
  take?: number;
  skip?: number;
  _count?: Record<string, boolean> | true;
  _avg?: Record<string, boolean>;
  _sum?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

export interface GroupByArgs extends AggregateArgs {
  by: string[];
  having?: WhereInput;
}
