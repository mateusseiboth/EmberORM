/**
 * Driver-free entry point for editor tooling (the VSCode extension and any
 * other language tooling). Re-exports only the schema layer — no database
 * driver — so consumers never pull in `node-firebird`.
 */
export {
  parseSchema,
  parseAndValidate,
  validateSchema,
  printSchema,
  formatSchema,
  completeRelations,
  type LoadedSchema,
} from "@ember/schema";

export {
  EmberError,
  SchemaParseError,
  SchemaValidationError,
} from "@ember/errors";

export type {
  SchemaDocument,
  ModelNode,
  FieldNode,
  EnumNode,
  ScalarType,
} from "@ember/ast";

export { SCALAR_TYPES } from "@ember/ast";
