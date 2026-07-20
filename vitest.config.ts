import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      // Resolve workspace packages through their `source` export condition,
      // so tests exercise TypeScript sources rather than stale dist builds.
      conditions: ["source", ...defaultServerConditions],
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Pages date fetches in wall-clock time; snapshots need one wall.
    env: { TZ: "UTC" },
    // E2e tests each shell out to git dozens of times; the slowest take ~3s
    // alone and overrun the 5s default when parallel workers contend.
    testTimeout: 15_000,
  },
});
