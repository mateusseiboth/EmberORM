import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));

// Built into <pkg>/dist/studio/web and served by src/studio/server.ts.
// `base: "./"` keeps asset URLs relative so they resolve under any host/port.
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  server: {
    // `npm run dev:studio` proxies the API to a locally-running `ember studio`.
    proxy: { "/api": "http://127.0.0.1:5757" },
  },
  build: {
    outDir: resolve(root, "..", "dist", "studio", "web"),
    emptyOutDir: true,
  },
});
