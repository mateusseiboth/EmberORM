import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import { generateClientSource } from "@ember/generator";

const SCHEMA = `model Bairro {
  codigo Int     @id
  nome   String
  guid   String?
}`;

const src = generateClientSource(parseSchema(SCHEMA));

const whereOf = (field: string) =>
  new RegExp(`export type BairroWhereInput = \\{[\\s\\S]*?\\n\\s+${field}\\?: ([^;]+);`).exec(src)?.[1];

describe("where input of nullable fields", () => {
  // The engine already compiles `{ guid: null }` to IS NULL and `{ guid: { not: null } }` to
  // IS NOT NULL; the generated type refused both.
  it("accepts null on an optional field", () => {
    expect(whereOf("guid")).toContain("| null");
  });

  it("accepts { not: null } on an optional field", () => {
    expect(whereOf("guid")).toContain("{ not: null }");
  });

  it("keeps null out of a required field", () => {
    expect(whereOf("nome")).not.toContain("null");
  });
});
