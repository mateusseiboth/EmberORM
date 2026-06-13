import { SchemaValidationError } from "@ember/errors";
import {
  SCALAR_TYPES,
  type SchemaDocument,
  findModel,
} from "@ember/ast";

/**
 * Structural validation of a parsed schema. Throws SchemaValidationError with
 * all detected problems at once so the user can fix them in a single pass.
 */
export function validateSchema(doc: SchemaDocument): void {
  const errors: string[] = [];
  const scalar = new Set<string>(SCALAR_TYPES);
  const enumNames = new Set(doc.enums.map((e) => e.name));
  const modelNames = new Set(doc.models.map((m) => m.name));

  const duplicateModels = findDuplicates(doc.models.map((m) => m.name));
  for (const name of duplicateModels) {
    errors.push(`Duplicate model '${name}'.`);
  }

  for (const model of doc.models) {
    const fieldNames = new Set<string>();
    for (const field of model.fields) {
      if (fieldNames.has(field.name)) {
        errors.push(`Duplicate field '${model.name}.${field.name}'.`);
      }
      fieldNames.add(field.name);

      const known =
        scalar.has(field.type) ||
        enumNames.has(field.type) ||
        modelNames.has(field.type);
      if (!known) {
        errors.push(
          `Field '${model.name}.${field.name}' has unknown type '${field.type}'.`,
        );
      }

      if (field.kind === "object" && field.relation) {
        validateRelation(doc, model.name, field.name, field.relation, errors);
      }
    }

    for (const pk of model.primaryKey) {
      if (!fieldNames.has(pk)) {
        errors.push(
          `Primary key field '${pk}' does not exist on model '${model.name}'.`,
        );
      }
    }

    const hasId =
      model.primaryKey.length > 0 || model.fields.some((f) => f.isId);
    if (!hasId) {
      errors.push(
        `Model '${model.name}' has no @id / @@id. Every model needs a primary key.`,
      );
    }
  }

  for (const enumNode of doc.enums) {
    if (enumNode.values.length === 0) {
      errors.push(`Enum '${enumNode.name}' has no values.`);
    }
  }

  if (errors.length > 0) {
    throw new SchemaValidationError("Schema validation failed", errors);
  }
}

function validateRelation(
  doc: SchemaDocument,
  modelName: string,
  fieldName: string,
  relation: { fields?: string[]; references?: string[] },
  errors: string[],
): void {
  const model = findModel(doc, modelName);
  if (!model) return;
  for (const f of relation.fields ?? []) {
    if (!model.fields.some((mf) => mf.name === f)) {
      errors.push(
        `Relation '${modelName}.${fieldName}' references local field '${f}' which does not exist.`,
      );
    }
  }
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dups.add(v);
    seen.add(v);
  }
  return [...dups];
}
