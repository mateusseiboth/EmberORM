import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "client/index": "src/client/index.ts",
    "cli/bin": "src/cli/bin.ts",
    "studio/server": "src/studio/server.ts",
    editor: "src/editor.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  target: "node18",
  outDir: "dist",
  external: ["node-firebird"],
});
