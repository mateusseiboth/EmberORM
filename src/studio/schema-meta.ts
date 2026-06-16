/**
 * Schema metadata projected for the EmberStudio frontend.
 *
 * The full {@link SchemaDocument} carries parser/driver detail the UI does not
 * need. {@link buildStudioSchema} flattens it to a stable, JSON-friendly shape:
 * one entry per model with the field info the grid and forms render from
 * (type, kind, id/required/list flags, relation target, enum values, defaults).
 */
import type {
  FieldNode,
  ModelNode,
  RelationInfo,
  SchemaDocument,
} from "@ember/ast";

export interface StudioField {
  name: string;
  /** ScalarType name, enum name, or related model name. */
  type: string;
  kind: "scalar" | "enum" | "object";
  isList: boolean;
  isRequired: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  isGenerated: boolean;
  hasDefault: boolean;
  documentation?: string;
  relation?: RelationInfo;
}

export interface StudioModel {
  name: string;
  /** Field names forming the primary key. */
  primaryKey: string[];
  fields: StudioField[];
  documentation?: string;
}

export interface StudioEnum {
  name: string;
  values: string[];
}

export interface StudioSchema {
  models: StudioModel[];
  enums: StudioEnum[];
}

export function buildStudioSchema(schema: SchemaDocument): StudioSchema {
  return {
    models: schema.models.map(toStudioModel),
    enums: schema.enums.map((e) => ({
      name: e.name,
      values: e.values.map((v) => v.name),
    })),
  };
}

function toStudioModel(model: ModelNode): StudioModel {
  const primaryKey =
    model.primaryKey.length > 0
      ? model.primaryKey
      : model.fields.filter((f) => f.isId).map((f) => f.name);
  return {
    name: model.name,
    primaryKey,
    fields: model.fields.map(toStudioField),
    documentation: model.documentation,
  };
}

function toStudioField(field: FieldNode): StudioField {
  return {
    name: field.name,
    type: field.type,
    kind: field.kind,
    isList: field.isList,
    isRequired: field.isRequired,
    isId: field.isId,
    isUnique: field.isUnique,
    isUpdatedAt: field.isUpdatedAt,
    isGenerated: isGenerated(field),
    hasDefault: field.default !== undefined,
    documentation: field.documentation,
    relation: field.relation,
  };
}

/** Fields the database fills in (autoincrement / updatedAt) — read-only in forms. */
function isGenerated(field: FieldNode): boolean {
  if (field.isUpdatedAt) return true;
  return field.default?.function?.name === "autoincrement";
}
