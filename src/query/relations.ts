import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  fieldColumn,
  findModel,
  idFields,
} from "@ember/ast";
import { QueryValidationError } from "@ember/errors";

export interface ResolvedRelation {
  field: FieldNode;
  relatedModel: ModelNode;
  /** Field names on the owning model joined to the related model. */
  fromFields: string[];
  /** Field names on the related model. */
  toFields: string[];
  /** Column names (db) on the owning model. */
  fromColumns: string[];
  /** Column names (db) on the related model. */
  toColumns: string[];
  isList: boolean;
  /** True when this side physically holds the foreign key. */
  owns: boolean;
}

/**
 * Resolve how a relation field joins its two models, regardless of which side
 * declared `@relation(fields/references)`. Returns the column pairs the engine
 * uses to load and stitch related rows.
 */
export function resolveRelation(
  schema: SchemaDocument,
  model: ModelNode,
  field: FieldNode,
): ResolvedRelation {
  if (field.kind !== "object") {
    throw new QueryValidationError(
      `Field '${model.name}.${field.name}' is not a relation.`,
    );
  }
  const relatedModel = findModel(schema, field.type);
  if (!relatedModel) {
    throw new QueryValidationError(
      `Relation '${model.name}.${field.name}' points to unknown model '${field.type}'.`,
    );
  }

  // Owning side: this field declares fields/references directly.
  if (field.relation?.fields?.length) {
    const fromFields = field.relation.fields;
    const toFields =
      field.relation.references ?? idFields(relatedModel).map((f) => f.name);
    return build(field, model, relatedModel, fromFields, toFields, true);
  }

  // Back side: find the partner field on the related model that owns the FK.
  const partner = findPartnerField(schema, model, field, relatedModel);
  if (partner?.relation?.fields?.length) {
    // related.partner.fields -> related columns; references -> this model columns
    const toFields = partner.relation.fields;
    const fromFields =
      partner.relation.references ?? idFields(model).map((f) => f.name);
    return build(field, model, relatedModel, fromFields, toFields, false);
  }

  // Fallback: implicit relation by primary keys (rare, e.g. 1:1 by id).
  const fromFields = idFields(model).map((f) => f.name);
  const toFields = idFields(relatedModel).map((f) => f.name);
  return build(field, model, relatedModel, fromFields, toFields, false);
}

function build(
  field: FieldNode,
  model: ModelNode,
  relatedModel: ModelNode,
  fromFields: string[],
  toFields: string[],
  owns: boolean,
): ResolvedRelation {
  return {
    field,
    relatedModel,
    fromFields,
    toFields,
    fromColumns: fromFields.map((n) => columnOf(model, n)),
    toColumns: toFields.map((n) => columnOf(relatedModel, n)),
    isList: field.isList,
    owns,
  };
}

function columnOf(model: ModelNode, fieldName: string): string {
  const f = model.fields.find((x) => x.name === fieldName);
  if (!f) {
    throw new QueryValidationError(
      `Field '${fieldName}' not found on model '${model.name}'.`,
    );
  }
  return fieldColumn(f);
}

function findPartnerField(
  _schema: SchemaDocument,
  model: ModelNode,
  field: FieldNode,
  relatedModel: ModelNode,
): FieldNode | undefined {
  const candidates = relatedModel.fields.filter(
    (f) => f.kind === "object" && f.type === model.name,
  );
  if (field.relation?.name) {
    const byName = candidates.find(
      (f) => f.relation?.name === field.relation?.name,
    );
    if (byName) return byName;
  }
  // Prefer the side that owns the FK.
  const owning = candidates.find((f) => f.relation?.fields?.length);
  return owning ?? candidates[0];
}
