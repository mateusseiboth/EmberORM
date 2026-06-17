import {
  type FieldNode,
  type ModelNode,
  type NativeType,
  type SchemaDocument,
  fieldColumn,
  idFields,
  modelTable,
  relationFields,
  scalarFields,
} from "@ember/ast";

export interface ColumnChange {
  field: FieldNode;
  table: string;
  typeChanged: boolean;
  nullabilityChanged: boolean;
  /** Desired column is autoincrement but the live column is not. */
  identityAdded: boolean;
}

export interface UniqueSpec {
  name: string;
  columns: string[];
}

export interface ForeignKeySpec {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexSpec {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ModelChange {
  model: ModelNode; // desired
  table: string;
  addedColumns: FieldNode[];
  droppedColumns: string[];
  changedColumns: ColumnChange[];
  addedUniques: UniqueSpec[];
  addedForeignKeys: ForeignKeySpec[];
}

export interface SchemaDiff {
  createdModels: ModelNode[];
  droppedTables: string[];
  modelChanges: ModelChange[];
}

/**
 * Structural diff turning `current` (usually introspected from the live DB)
 * into `desired` (the `.ember` schema). Pure and dialect-independent; the
 * planner converts it to DDL.
 *
 * Scope (safe subset): create/drop tables, add/drop/alter columns, and add
 * unique/foreign-key constraints that don't already exist. Dropping
 * constraints and plain (non-constraint) indexes on existing tables is left to
 * explicit user action — see doc/migrations.md.
 */
export function diffSchemas(
  desired: SchemaDocument,
  current: SchemaDocument,
): SchemaDiff {
  const currentByTable = new Map(
    current.models.map((m) => [modelTable(m), m]),
  );
  const desiredTables = new Set(desired.models.map((m) => modelTable(m)));

  const createdModels: ModelNode[] = [];
  const modelChanges: ModelChange[] = [];

  for (const model of desired.models) {
    const table = modelTable(model);
    const currentModel = currentByTable.get(table);
    if (!currentModel) {
      createdModels.push(model);
      continue;
    }
    const change = diffModel(desired, model, currentModel, table);
    if (hasModelChanges(change)) modelChanges.push(change);
  }

  const droppedTables = current.models
    .map((m) => modelTable(m))
    .filter((t) => !desiredTables.has(t));

  return { createdModels, droppedTables, modelChanges };
}

function diffModel(
  desired: SchemaDocument,
  model: ModelNode,
  current: ModelNode,
  table: string,
): ModelChange {
  const desiredCols = new Map(
    scalarFields(model).map((f) => [fieldColumn(f), f]),
  );
  const currentCols = new Map(
    scalarFields(current).map((f) => [fieldColumn(f), f]),
  );
  // Primary-key columns are NOT NULL by definition in every SQL engine
  // (Firebird forces this even when the column is declared nullable). Treating
  // a PK member as required avoids a phantom "drop NOT NULL" that the database
  // silently ignores and the diff then re-emits on every run.
  const pkColumns = new Set(idFields(model).map((f) => fieldColumn(f)));

  const addedColumns: FieldNode[] = [];
  const changedColumns: ColumnChange[] = [];
  for (const [col, field] of desiredCols) {
    const existing = currentCols.get(col);
    if (!existing) {
      addedColumns.push(field);
      continue;
    }
    const typeChanged = !sameColumnType(field, existing);
    const desiredRequired = field.isRequired || pkColumns.has(col);
    const nullabilityChanged = desiredRequired !== existing.isRequired;
    const identityAdded = isAutoincrement(field) && !isAutoincrement(existing);
    if (typeChanged || nullabilityChanged || identityAdded) {
      changedColumns.push({
        field,
        table,
        typeChanged,
        nullabilityChanged,
        identityAdded,
      });
    }
  }

  const droppedColumns = [...currentCols.keys()].filter(
    (c) => !desiredCols.has(c),
  );

  const currentUniqueSets = uniqueColumnSets(current).map(setKey);
  const addedUniques = uniqueColumnSets(model)
    .filter((cols) => !currentUniqueSets.includes(setKey(cols)))
    .map((cols) => ({ name: constraintName("UQ", table, cols), columns: cols }));

  const currentFkSets = foreignKeys(desired, current).map(fkKey);
  const addedForeignKeys = foreignKeys(desired, model)
    .filter((fk) => !currentFkSets.includes(fkKey(fk)))
    .map((fk) => ({ ...fk, name: constraintName("FK", table, fk.columns) }));

  return {
    model,
    table,
    addedColumns,
    droppedColumns,
    changedColumns,
    addedUniques,
    addedForeignKeys,
  };
}

function hasModelChanges(c: ModelChange): boolean {
  return (
    c.addedColumns.length > 0 ||
    c.droppedColumns.length > 0 ||
    c.changedColumns.length > 0 ||
    c.addedUniques.length > 0 ||
    c.addedForeignKeys.length > 0
  );
}

// ---- extractors -----------------------------------------------------------

/** Unique column-sets from single @unique fields and composite @@unique. */
export function uniqueColumnSets(model: ModelNode): string[][] {
  const sets: string[][] = [];
  for (const f of scalarFields(model)) {
    if (f.isUnique) sets.push([fieldColumn(f)]);
  }
  for (const u of model.uniqueIndexes) {
    sets.push(u.fields.map((name) => columnFor(model, name)));
  }
  return sets;
}

export function indexSpecs(model: ModelNode): IndexSpec[] {
  return model.indexes.map((i) => ({
    name: i.name ?? constraintName("IDX", modelTable(model), i.fields.map((n) => columnFor(model, n))),
    columns: i.fields.map((name) => columnFor(model, name)),
    unique: i.unique,
  }));
}

/** Owning-side foreign keys declared on this model. */
export function foreignKeys(
  schema: SchemaDocument,
  model: ModelNode,
): Omit<ForeignKeySpec, "name">[] {
  const out: Omit<ForeignKeySpec, "name">[] = [];
  for (const f of relationFields(model)) {
    const rel = f.relation;
    if (!rel?.fields?.length) continue;
    const refModel = schema.models.find((m) => m.name === f.type);
    if (!refModel) continue;
    out.push({
      columns: rel.fields.map((name) => columnFor(model, name)),
      refTable: modelTable(refModel),
      refColumns: (rel.references ?? []).map((name) => columnFor(refModel, name)),
      onDelete: rel.onDelete,
      onUpdate: rel.onUpdate,
    });
  }
  return out;
}

function columnFor(model: ModelNode, fieldName: string): string {
  const f = model.fields.find((x) => x.name === fieldName);
  return f ? fieldColumn(f) : fieldName.toUpperCase();
}

// ---- comparison helpers ---------------------------------------------------

/** A field is autoincrement when its default is the `autoincrement()` function. */
function isAutoincrement(field: FieldNode): boolean {
  return field.default?.function?.name === "autoincrement";
}

function sameColumnType(a: FieldNode, b: FieldNode): boolean {
  if (a.type !== b.type) return false;
  return sameNative(a.nativeType, b.nativeType);
}

function sameNative(a?: NativeType, b?: NativeType): boolean {
  if (!a && !b) return true;
  if (!a || !b) return true; // one side unspecified: treat as compatible
  return a.name === b.name && a.args.join(",") === b.args.join(",");
}

function setKey(cols: string[]): string {
  return [...cols].sort().join(",");
}

function fkKey(fk: Omit<ForeignKeySpec, "name">): string {
  return `${setKey(fk.columns)}->${fk.refTable}(${setKey(fk.refColumns)})`;
}

/** Deterministic, length-capped constraint/index name. */
export function constraintName(
  prefix: string,
  table: string,
  columns: string[],
): string {
  const base = `${prefix}_${table}_${columns.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (base.length <= 31) return base;
  // Cap to Firebird's classic 31-char identifier limit with a stable hash.
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) | 0;
  const suffix = Math.abs(hash).toString(36).slice(0, 6);
  return `${base.slice(0, 24)}_${suffix}`;
}
