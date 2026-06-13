import {
  type FieldNode,
  type ModelNode,
  type SchemaDocument,
  findModel,
  idFields,
} from "@ember/ast";
import { camelCase, pascalCase, pluralize } from "@ember/utils";

/**
 * Auto-complete missing relation sides, mirroring Prisma's formatter:
 *
 * - If a model declares the **owning** side (`field Type @relation(fields,
 *   references)`), the referenced model gets the opposite **back-relation**
 *   (a list, or a to-one for 1:1) if it is missing.
 * - If a model declares a **list** (`items Type[]`), the element model gets the
 *   owning to-one field plus its scalar foreign key, if missing.
 * - A bare to-one (`field Type` with no `@relation` and no partner) is upgraded
 *   to the owning side (scalar FK + `@relation`) and the other model gets the
 *   back-relation list.
 *
 * Mutates and returns `doc`. Safe to run repeatedly (idempotent): a relation
 * whose partner already exists is left untouched.
 */
export function completeRelations(doc: SchemaDocument): SchemaDocument {
  // Snapshot the original relation fields so newly-added fields aren't
  // re-processed within the same pass.
  const original: { model: ModelNode; field: FieldNode }[] = [];
  for (const model of doc.models) {
    for (const field of model.fields) {
      if (field.kind === "object") original.push({ model, field });
    }
  }

  for (const { model, field } of original) {
    const related = findModel(doc, field.type);
    if (!related) continue;
    if (hasPartner(related, model, field)) continue;

    if (field.isList) {
      addOwningSide(related, model, field);
    } else if (field.relation?.fields?.length) {
      addBackRelation(related, model, field);
    } else {
      upgradeBareToOne(doc, model, field);
    }
  }

  return doc;
}

function hasPartner(
  related: ModelNode,
  model: ModelNode,
  field: FieldNode,
): boolean {
  return related.fields.some(
    (f) =>
      f !== field &&
      f.kind === "object" &&
      f.type === model.name &&
      relationNamesMatch(f, field),
  );
}

function relationNamesMatch(a: FieldNode, b: FieldNode): boolean {
  const an = a.relation?.name;
  const bn = b.relation?.name;
  if (an && bn) return an === bn; // both named: must match
  if (!an && !bn) return true; // both unnamed: the single relation between them
  return false; // one named, one not: different relations
}

/** Add the opposite back-relation (list, or to-one for 1:1) on `related`. */
function addBackRelation(
  related: ModelNode,
  owner: ModelNode,
  owning: FieldNode,
): void {
  // A unique foreign key (the scalar field(s) the relation maps to) implies a
  // 1:1, so the back side is a to-one rather than a list.
  const fkFields = (owning.relation?.fields ?? [])
    .map((n) => owner.fields.find((f) => f.name === n))
    .filter((f): f is FieldNode => !!f);
  const isOneToOne = fkFields.length > 0 && fkFields.every((f) => f.isUnique);
  const baseName = isOneToOne
    ? camelCase(owner.name)
    : camelCase(pluralize(owner.name));
  const name = uniqueFieldName(related, baseName);

  related.fields.push({
    name,
    type: owner.name,
    kind: "object",
    isList: !isOneToOne,
    isRequired: false,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    // Only emit @relation when the relation is named; an unnamed back-relation
    // carries no attribute (matches Prisma's formatter output).
    ...(owning.relation?.name ? { relation: { name: owning.relation.name } } : {}),
  });
}

/** Add the owning to-one field + scalar FK on `related` (which holds the FK). */
function addOwningSide(
  related: ModelNode,
  parent: ModelNode,
  listField: FieldNode,
): void {
  const ref = idFields(parent)[0];
  if (!ref) return;

  const relationField = uniqueFieldName(related, camelCase(parent.name));
  const fkName = uniqueFieldName(
    related,
    `${camelCase(parent.name)}${pascalCase(ref.name)}`,
  );

  related.fields.push({
    name: fkName,
    type: ref.type,
    kind: "scalar",
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    ...(ref.nativeType ? { nativeType: ref.nativeType } : {}),
  });

  related.fields.push({
    name: relationField,
    type: parent.name,
    kind: "object",
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    relation: {
      ...(listField.relation?.name ? { name: listField.relation.name } : {}),
      fields: [fkName],
      references: [ref.name],
    },
  });
}

/** Upgrade `field Type` (bare to-one) to the owning side and add the back list. */
function upgradeBareToOne(
  doc: SchemaDocument,
  model: ModelNode,
  field: FieldNode,
): void {
  const related = findModel(doc, field.type);
  if (!related) return;
  const ref = idFields(related)[0];
  if (!ref) return;

  const fkName = uniqueFieldName(model, `${field.name}${pascalCase(ref.name)}`);
  // Insert the scalar FK just before the relation field for readability.
  const idx = model.fields.indexOf(field);
  model.fields.splice(idx, 0, {
    name: fkName,
    type: ref.type,
    kind: "scalar",
    isList: false,
    isRequired: field.isRequired,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    ...(ref.nativeType ? { nativeType: ref.nativeType } : {}),
  });
  field.relation = {
    ...(field.relation ?? {}),
    fields: [fkName],
    references: [ref.name],
  };

  addBackRelation(related, model, field);
}

function uniqueFieldName(model: ModelNode, base: string): string {
  let name = base || "relation";
  let i = 1;
  while (model.fields.some((f) => f.name === name)) name = `${base}_${++i}`;
  return name;
}
