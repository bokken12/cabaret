import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Resolve workspace packages through their `source` export condition, so
    // the app builds from TypeScript sources rather than stale dist builds.
    conditions: ["source", ...defaultClientConditions],
  },
});
