import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  // dist/ is shared with tsc output (dist/app, dist/server), so build into a subdirectory.
  build: { outDir: "dist/site" },
  resolve: {
    // Resolve workspace packages through their `source` export condition, so
    // the app builds from TypeScript sources rather than stale dist builds.
    conditions: ["source", ...defaultClientConditions],
  },
});
