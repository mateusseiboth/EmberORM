/**
 * EmberStudio — local web GUI to browse and edit Firebird data, the EmberORM
 * counterpart to Prisma Studio. Started by `ember studio`; also usable
 * programmatically via {@link startStudioServer}.
 */
export {
  startStudioServer,
  type StudioServer,
  type StudioServerOptions,
} from "./server";
export { buildStudioSchema } from "./schema-meta";
export type {
  StudioSchema,
  StudioModel,
  StudioField,
  StudioEnum,
} from "./schema-meta";
export {
  serializeRow,
  serializeRows,
  serializeValue,
  deserializeData,
  deserializeWhere,
  deserializeValue,
  type BytesToken,
} from "./serialize";
