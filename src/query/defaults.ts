import { randomUUID } from "node:crypto";
import { type FieldNode, type ModelNode } from "@ember/ast";

/**
 * Compute default values in JS at write time. Computing here (rather than
 * relying on DB-side DEFAULT clauses) keeps behavior identical across Firebird
 * versions and lets EmberORM return the generated values without extra reads.
 *
 * `autoincrement()` is intentionally skipped: it is produced by the database
 * identity/generator and read back via RETURNING.
 */
export function applyCreateDefaults(
  model: ModelNode,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const field of model.fields) {
    if (field.kind === "object") continue;

    if (field.isUpdatedAt && out[field.name] === undefined) {
      out[field.name] = new Date();
      continue;
    }
    if (out[field.name] !== undefined) continue;

    const def = field.default;
    if (!def) continue;

    if (def.function) {
      const computed = computeFunctionDefault(def.function.name);
      if (computed !== SKIP) out[field.name] = computed;
      continue;
    }
    if (def.literal !== undefined) {
      out[field.name] = def.literal;
    }
  }
  return out;
}

/** Set @updatedAt fields on update operations. */
export function applyUpdateDefaults(
  model: ModelNode,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const field of model.fields) {
    if (field.isUpdatedAt && out[field.name] === undefined) {
      out[field.name] = new Date();
    }
  }
  return out;
}

const SKIP = Symbol("skip-default");

function computeFunctionDefault(name: string): unknown {
  switch (name) {
    case "now":
      return new Date();
    case "uuid":
      return randomUUID();
    case "cuid":
      return generateCuid();
    case "autoincrement":
      return SKIP;
    default:
      return SKIP;
  }
}

/** Minimal collision-resistant id (cuid-like) without external deps. */
function generateCuid(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${time}${rand}`;
}

export function isAutoincrement(field: FieldNode): boolean {
  return field.default?.function?.name === "autoincrement";
}
