import { describe, expect, it } from "vitest";
import type { SchemaDocument } from "@ember/ast";
import { keepExistingConfig } from "@ember/introspect";

const pulled: SchemaDocument = {
  generators: [
    { name: "client", provider: "ember-client-js", output: "../generated", config: {} },
  ],
  models: [],
  enums: [],
};

describe("db pull keeps the existing configuration", () => {
  it("keeps the generator output of the schema being replaced", () => {
    const existing: SchemaDocument = {
      ...pulled,
      generators: [
        { name: "client", provider: "ember-client-js", output: "../src/origem/generated", config: {} },
      ],
    };

    expect(keepExistingConfig(pulled, existing).generators[0]?.output).toBe(
      "../src/origem/generated",
    );
  });

  it("uses the default generator when there is no previous schema", () => {
    expect(keepExistingConfig(pulled, undefined).generators[0]?.output).toBe("../generated");
  });

  it("uses the default generator when the previous schema had none", () => {
    expect(keepExistingConfig(pulled, { ...pulled, generators: [] }).generators).toHaveLength(1);
  });
});
