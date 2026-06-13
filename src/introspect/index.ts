import {
  type DefaultValue,
  type EnumNode,
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
} from "@ember/ast";
import type { SqlDriver } from "@ember/driver";
import { camelCase, lowerFirst, pascalCase, pluralize, uniq } from "@ember/utils";
import {
  FirebirdMetadataReader,
  type RawColumn,
  type RawConstraint,
} from "./firebird-meta";
import { mapColumnType } from "./type-map";

export { FirebirdMetadataReader } from "./firebird-meta";
export { mapColumnType } from "./type-map";

export interface IntrospectOptions {
  datasource?: { name: string; provider: string; envVar?: string; url?: string };
}

/**
 * Reverse-engineer a SchemaDocument from a live Firebird database.
 * Table/column names are kept as-is via `@@map`/`@map` when the idiomatic
 * Ember name differs, and foreign keys become relation fields on both sides.
 */
export class Introspector {
  constructor(private readonly driver: SqlDriver) {}

  async introspect(options: IntrospectOptions = {}): Promise<SchemaDocument> {
    const { tables, columns, constraints } = await this.driver.transaction(
      async (tx) => {
        const reader = new FirebirdMetadataReader(tx);
        return {
          tables: await reader.tables(),
          columns: await reader.columns(),
          constraints: await reader.constraints(),
        };
      },
      { isolation: "READ_COMMITTED_READ_ONLY" },
    );

    const columnsByTable = groupBy(columns, (c) => c.table);
    const constraintsByTable = groupBy(constraints, (c) => c.table);
    const modelNames = buildNameMap(tables);

    const models: ModelNode[] = tables.map((table) =>
      this.buildModel(
        table,
        modelNames,
        columnsByTable.get(table) ?? [],
        constraintsByTable.get(table) ?? [],
      ),
    );

    addRelations(models, modelNames, constraints);

    const enums: EnumNode[] = [];
    const doc: SchemaDocument = {
      generators: [
        { name: "client", provider: "ember-client-js", output: "../generated", config: {} },
      ],
      models,
      enums,
    };
    if (options.datasource) {
      doc.datasource = {
        name: options.datasource.name,
        provider: options.datasource.provider,
        url: options.datasource.envVar
          ? { kind: "env", value: options.datasource.envVar }
          : { kind: "literal", value: options.datasource.url ?? "" },
      };
    }
    return doc;
  }

  private buildModel(
    table: string,
    modelNames: Map<string, string>,
    columns: RawColumn[],
    constraints: RawConstraint[],
  ): ModelNode {
    const modelName = modelNames.get(table)!;
    const pk = constraints.find((c) => c.type === "PRIMARY KEY");
    const uniques = constraints.filter((c) => c.type === "UNIQUE");

    const fieldNameMap = buildNameMap(columns.map((c) => c.name), camelCase);
    const fields: FieldNode[] = columns.map((col) =>
      buildField(col, fieldNameMap, pk, uniques),
    );

    const model: ModelNode = {
      name: modelName,
      dbName: modelName !== table ? table : undefined,
      fields,
      primaryKey:
        pk && pk.columns.length > 1
          ? pk.columns.map((c) => fieldNameMap.get(c)!)
          : [],
      uniqueIndexes: uniques
        .filter((u) => u.columns.length > 1)
        .map((u) => ({ fields: u.columns.map((c) => fieldNameMap.get(c)!) })),
      indexes: [],
    };
    return model;
  }
}

function buildField(
  col: RawColumn,
  fieldNameMap: Map<string, string>,
  pk: RawConstraint | undefined,
  uniques: RawConstraint[],
): FieldNode {
  const fieldName = fieldNameMap.get(col.name)!;
  const mapped = mapColumnType(col);
  const isSingleIdCol =
    !!pk && pk.columns.length === 1 && pk.columns[0] === col.name;
  const isSingleUnique = uniques.some(
    (u) => u.columns.length === 1 && u.columns[0] === col.name,
  );

  const field: FieldNode = {
    name: fieldName,
    type: mapped.scalar,
    kind: "scalar",
    isList: false,
    isRequired: col.notNull || isSingleIdCol,
    isId: isSingleIdCol,
    isUnique: isSingleUnique,
    isUpdatedAt: false,
    dbName: fieldName !== col.name ? col.name : undefined,
    nativeType: mapped.native,
    default: parseDefault(col),
  };
  return field;
}

function parseDefault(col: RawColumn): DefaultValue | undefined {
  if (col.isIdentity) return { function: { name: "autoincrement", args: [] } };
  if (!col.defaultSource) return undefined;
  const src = col.defaultSource.replace(/^DEFAULT\s+/i, "").trim();
  if (/^CURRENT_TIMESTAMP/i.test(src)) return { function: { name: "now", args: [] } };
  if (/^(TRUE|FALSE)$/i.test(src)) return { literal: /^TRUE$/i.test(src) };
  if (/^-?\d+(\.\d+)?$/.test(src)) return { literal: Number(src) };
  const str = /^'(.*)'$/.exec(src);
  if (str) return { literal: str[1]! };
  return undefined;
}

/**
 * Create relation fields on both sides of every foreign key:
 * - the child gets a to-one field with `@relation(fields, references)`;
 * - the parent gets a to-many back relation (a list).
 */
function addRelations(
  models: ModelNode[],
  modelNames: Map<string, string>,
  constraints: RawConstraint[],
): void {
  const byName = new Map(models.map((m) => [m.name, m]));
  for (const fk of constraints) {
    if (fk.type !== "FOREIGN KEY" || !fk.references) continue;
    const childModel = byName.get(modelNames.get(fk.table)!);
    const parentModel = byName.get(modelNames.get(fk.references.table)!);
    if (!childModel || !parentModel) continue;

    const localFieldNames = fk.columns.map((c) => columnToField(childModel, c));
    const refFieldNames = fk.references.columns.map((c) =>
      columnToField(parentModel, c),
    );

    const childFieldName = uniqueFieldName(childModel, lowerFirst(parentModel.name));
    childModel.fields.push({
      name: childFieldName,
      type: parentModel.name,
      kind: "object",
      isList: false,
      isRequired: localFieldNames.every(
        (n) => childModel.fields.find((f) => f.name === n)?.isRequired,
      ),
      isId: false,
      isUnique: false,
      isUpdatedAt: false,
      relation: {
        fields: localFieldNames,
        references: refFieldNames,
        onDelete: mapRule(fk.deleteRule),
        onUpdate: mapRule(fk.updateRule),
      },
    });

    const backName = uniqueFieldName(
      parentModel,
      lowerFirst(pluralize(childModel.name)),
    );
    parentModel.fields.push({
      name: backName,
      type: childModel.name,
      kind: "object",
      isList: true,
      isRequired: false,
      isId: false,
      isUnique: false,
      isUpdatedAt: false,
    });
  }
}

function columnToField(model: ModelNode, column: string): string {
  const f = model.fields.find((x) => (x.dbName ?? x.name) === column);
  return f ? f.name : camelCase(column);
}

function uniqueFieldName(model: ModelNode, base: string): string {
  let name = base;
  let i = 1;
  while (model.fields.some((f) => f.name === name)) name = `${base}_${++i}`;
  return name;
}

function mapRule(rule?: string) {
  switch ((rule ?? "").toUpperCase()) {
    case "CASCADE":
      return "Cascade" as const;
    case "SET NULL":
      return "SetNull" as const;
    case "SET DEFAULT":
      return "SetDefault" as const;
    case "NO ACTION":
      return "NoAction" as const;
    case "RESTRICT":
      return "Restrict" as const;
    default:
      return undefined;
  }
}

// ---- name helpers ---------------------------------------------------------

function buildNameMap(
  dbNames: string[],
  transform: (s: string) => string = pascalCase,
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const dbName of uniq(dbNames)) {
    let name = transform(dbName);
    if (!name) name = dbName;
    let candidate = name;
    let i = 1;
    while (used.has(candidate)) candidate = `${name}_${++i}`;
    used.add(candidate);
    map.set(dbName, candidate);
  }
  return map;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}
