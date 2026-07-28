#!/usr/bin/env node
import { buildApplication, buildRouteMap, run } from "@stricli/core";
import { fetchCommand } from "./fetch.ts";

const root = buildRouteMap({
  routes: { fetch: fetchCommand },
  docs: {
    brief: "Cabaret command-line interface",
  },
});

const app = buildApplication(root, { name: "cabaret" });

await run(app, process.argv.slice(2), { process });
