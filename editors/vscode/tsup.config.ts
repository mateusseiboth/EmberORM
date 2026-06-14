import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    extension: "src/extension.ts",
    server: "src/server/server.ts",
  },
  format: ["cjs"],
  outDir: "out",
  target: "node18",
  // VSCode provides `vscode` at runtime; bundle everything else (ember-orm and
  // the language-server libraries) so the extension ships self-contained.
  external: ["vscode"],
  noExternal: [
    "ember-orm",
    "vscode-languageclient",
    "vscode-languageserver",
    "vscode-languageserver-textdocument",
  ],
  clean: true,
  sourcemap: true,
  dts: false,
});
