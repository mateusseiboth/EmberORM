import { defineConfig } from "tsup";

export default defineConfig({
  entry: { extension: "src/extension.ts" },
  format: ["cjs"],
  outDir: "out",
  target: "node18",
  // VSCode provides the `vscode` module at runtime; everything else is bundled
  // so the extension ships as a single file with no install step.
  external: ["vscode"],
  noExternal: ["ember-orm"],
  clean: true,
  sourcemap: true,
  dts: false,
});
