import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@ember/schema": r("./src/schema/index.ts"),
      "@ember/ast": r("./src/ast/index.ts"),
      "@ember/driver": r("./src/driver/index.ts"),
      "@ember/sql": r("./src/sql/index.ts"),
      "@ember/query": r("./src/query/index.ts"),
      "@ember/client": r("./src/client/index.ts"),
      "@ember/introspect": r("./src/introspect/index.ts"),
      "@ember/generator": r("./src/generator/index.ts"),
      "@ember/errors": r("./src/errors/index.ts"),
      "@ember/utils": r("./src/utils/index.ts"),
      "@ember/types": r("./src/types/index.ts"),
    },
  },
});
