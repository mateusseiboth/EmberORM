import {
  type AttributeArgValue,
  type DefaultValue,
  type EnumNode,
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
} from "@ember/ast";

/**
 * Serializes a SchemaDocument back into `.ember` source text.
 * Used by `ember db pull` (introspection output) and `ember format`.
 * Field columns are aligned for readability, mirroring Prisma's formatter.
 */
export function printSchema(doc: SchemaDocument): string {
  const blocks: string[] = [];

  if (doc.datasource) {
    const ds = doc.datasource;
    const url =
      ds.url.kind === "env"
        ? `env("${ds.url.value}")`
        : `"${ds.url.value}"`;
    blocks.push(
      `datasource ${ds.name} {\n  provider = "${ds.provider}"\n  url      = ${url}\n}`,
    );
  }

  for (const gen of doc.generators) {
    const lines = [`  provider = "${gen.provider}"`];
    if (gen.output) lines.push(`  output   = "${gen.output}"`);
    for (const [k, v] of Object.entries(gen.config)) {
      if (k === "provider" || k === "output") continue;
      lines.push(`  ${k} = "${v}"`);
    }
    blocks.push(`generator ${gen.name} {\n${lines.join("\n")}\n}`);
  }

  for (const enumNode of doc.enums) {
    blocks.push(printEnum(enumNode));
  }

  for (const model of doc.models) {
    blocks.push(printModel(model));
  }

  return blocks.join("\n\n") + "\n";
}

function printEnum(node: EnumNode): string {
  const lines: string[] = [];
  if (node.documentation) lines.push(...docLines(node.documentation));
  lines.push(`enum ${node.name} {`);
  for (const v of node.values) {
    lines.push(`  ${v.name}${v.dbName ? ` @map("${v.dbName}")` : ""}`);
  }
  if (node.dbName) lines.push(`\n  @@map("${node.dbName}")`);
  lines.push(`}`);
  return lines.join("\n");
}

function printModel(model: ModelNode): string {
  const lines: string[] = [];
  if (model.documentation) lines.push(...docLines(model.documentation));
  lines.push(`model ${model.name} {`);

  const nameWidth = Math.max(...model.fields.map((f) => f.name.length), 0);
  const typeWidth = Math.max(...model.fields.map((f) => fieldType(f).length), 0);

  for (const field of model.fields) {
    if (field.documentation) {
      lines.push(...docLines(field.documentation).map((l) => `  ${l}`));
    }
    const attrs = fieldAttributes(field);
    const name = field.name.padEnd(nameWidth);
    const type = fieldType(field).padEnd(typeWidth);
    lines.push(`  ${name} ${type}${attrs ? ` ${attrs}` : ""}`.trimEnd());
  }

  const blockAttrs = modelBlockAttributes(model);
  if (blockAttrs.length > 0) {
    lines.push("");
    for (const a of blockAttrs) lines.push(`  ${a}`);
  }

  lines.push(`}`);
  return lines.join("\n");
}

function fieldType(field: FieldNode): string {
  let t = field.type;
  if (field.isList) t += "[]";
  else if (!field.isRequired) t += "?";
  return t;
}

function fieldAttributes(field: FieldNode): string {
  const parts: string[] = [];
  if (field.isId) parts.push("@id");
  if (field.isUnique) parts.push("@unique");
  if (field.default) parts.push(`@default(${printDefault(field.default)})`);
  if (field.isUpdatedAt) parts.push("@updatedAt");
  if (field.relation) {
    const rel = field.relation;
    const args: string[] = [];
    if (rel.name) args.push(`"${rel.name}"`);
    if (rel.fields?.length) args.push(`fields: [${rel.fields.join(", ")}]`);
    if (rel.references?.length)
      args.push(`references: [${rel.references.join(", ")}]`);
    if (rel.onDelete) args.push(`onDelete: ${rel.onDelete}`);
    if (rel.onUpdate) args.push(`onUpdate: ${rel.onUpdate}`);
    parts.push(args.length ? `@relation(${args.join(", ")})` : "@relation");
  }
  if (field.nativeType) {
    const a = field.nativeType.args.length
      ? `(${field.nativeType.args.join(", ")})`
      : "";
    parts.push(`@db.${field.nativeType.name}${a}`);
  }
  if (field.dbName) parts.push(`@map("${field.dbName}")`);
  return parts.join(" ");
}

function printDefault(def: DefaultValue): string {
  if (def.function) {
    return `${def.function.name}(${def.function.args
      .map(printArgValue)
      .join(", ")})`;
  }
  if (typeof def.literal === "string") {
    // enum/ref defaults are unquoted identifiers
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(def.literal)
      ? def.literal
      : `"${def.literal}"`;
  }
  return String(def.literal);
}

function printArgValue(v: AttributeArgValue): string {
  switch (v.kind) {
    case "string":
      return `"${v.value}"`;
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "ref":
      return v.value;
    case "array":
      return `[${v.items.map(printArgValue).join(", ")}]`;
    case "function":
      return `${v.name}(${v.args.map(printArgValue).join(", ")})`;
  }
}

function modelBlockAttributes(model: ModelNode): string[] {
  const out: string[] = [];
  const inlineId =
    model.primaryKey.length === 1 &&
    model.fields.find((f) => f.name === model.primaryKey[0])?.isId;
  if (model.primaryKey.length > 0 && !inlineId) {
    out.push(`@@id([${model.primaryKey.join(", ")}])`);
  }
  for (const u of model.uniqueIndexes) {
    out.push(
      `@@unique([${u.fields.join(", ")}]${u.name ? `, map: "${u.name}"` : ""})`,
    );
  }
  for (const i of model.indexes) {
    out.push(
      `@@index([${i.fields.join(", ")}]${i.name ? `, map: "${i.name}"` : ""})`,
    );
  }
  if (model.dbName) out.push(`@@map("${model.dbName}")`);
  return out;
}

function docLines(documentation: string): string[] {
  return documentation.split("\n").map((l) => `/// ${l}`);
}
