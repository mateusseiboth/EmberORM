/** Mirrors the JSON shapes returned by src/studio (schema-meta + serialize). */

export interface RelationInfo {
  name?: string;
  fields?: string[];
  references?: string[];
}

export interface StudioField {
  name: string;
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

export type Row = Record<string, unknown>;
export type SortOrder = "asc" | "desc";

export interface BytesToken {
  $type: "bytes";
  base64: string;
}
