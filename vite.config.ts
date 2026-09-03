/**
 * Frontend build.
 *
 * `root: "web"` keeps browser code in one directory that the server build
 * (tsconfig.server.json) does not compile, so the two trees cannot accidentally
 * import each other. The only thing they share is `server/shared/dto.ts`, which
 * is types and pure constants with no Node imports — `scripts/verify-webapp.mjs`
 * checks that the shipped bundle contains no Node builtin, no engine module and
 * no RPC URL.
 *
 * NOTE ON SECRETS: nothing here reads `process.env` into the bundle, and no
 * `VITE_*` variable is defined. The RPC URL and any API key are runtime SERVER
 * configuration; a `VITE_` variable would be inlined into a public asset at
 * BUILD time, which is how provider keys end up in a JS file on a CDN. The image
 * must therefore be buildable with no RPC key at all, and it is.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `import.meta.dirname` rather than `__dirname`: this config is loaded as an ES
// module, and Vite's native config loader does not provide the CommonJS globals.

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      // Type-only in practice; the alias exists so the import path reads the
      // same in the browser and the server.
      "@shared": resolve(import.meta.dirname, "server/shared"),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist-web"),
    emptyOutDir: true,
    // Kept for a demo: if something in the graph looks wrong on the projector,
    // being able to read the shipped source beats guessing.
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Dev only. In production the browser talks to the same origin it was
    // served from, so there is no cross-origin configuration to get wrong and
    // no second public URL to secure.
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
});
