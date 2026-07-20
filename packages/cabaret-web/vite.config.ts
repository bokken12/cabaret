import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Resolve workspace packages through their `source` export condition, so
    // dev serves TypeScript sources rather than stale dist builds.
    conditions: ["source", ...defaultClientConditions],
  },
  build: {
    // dist/src and dist/server belong to tsc; the bundle keeps its own corner.
    outDir: "dist/client",
  },
  server: {
    port: 8484,
  },
});
