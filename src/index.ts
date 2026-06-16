/**
 * EmberORM — a Prisma-like ORM for Firebird.
 *
 * Public entry point. The typed client is produced by `ember generate` and
 * imported from your generated output directory; everything needed at runtime
 * and for tooling is re-exported here.
 */

// Schema & AST
export * from "@ember/ast";
export {
  parseSchema,
  parseAndValidate,
  loadSchema,
  findSchemaPath,
  resolveDatasourceUrl,
  printSchema,
  validateSchema,
  type LoadedSchema,
} from "@ember/schema";

// Errors
export * from "@ember/errors";

// Driver
export {
  createDriver,
  parseConnectionUrl,
  buildConnectionUrl,
  FirebirdDriver,
  type ConnectionConfig,
  type SqlDriver,
  type SqlValue,
  type TransactionContext,
  type TransactionOptions,
  type IsolationLevel,
} from "@ember/driver";

// SQL
export { Sql, FirebirdDialect, type SqlDialect } from "@ember/sql";

// Query engine & arg types
export {
  QueryEngine,
  type FindManyArgs,
  type FindUniqueArgs,
  type CreateArgs,
  type UpdateArgs,
  type UpsertArgs,
  type DeleteArgs,
  type AggregateArgs,
  type GroupByArgs,
  type WhereInput,
  type OrderByInput,
  type SelectInput,
  type IncludeInput,
} from "@ember/query";

// Client runtime
export {
  EmberClientBase,
  createClient,
  type ClientOptions,
  type ModelDelegate,
} from "@ember/client";

// Tooling (introspection + codegen) for programmatic use
export { Introspector } from "@ember/introspect";
export {
  ClientGenerator,
  generateClientSource,
  writeClient,
} from "@ember/generator";

// Migrations
export {
  Migrator,
  diffSchemas,
  planMigration,
  renderMigrationSql,
  splitStatements,
  FirebirdDdl,
} from "@ember/migrate";

// Studio (local data-browser GUI)
export {
  startStudioServer,
  buildStudioSchema,
  type StudioServer,
  type StudioServerOptions,
  type StudioSchema,
} from "@ember/studio";
