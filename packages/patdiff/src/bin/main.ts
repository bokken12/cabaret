#!/usr/bin/env node
/** CLI entry point. Translation of OCaml's [Patdiff_bin.Main]. */

import { createRequire } from "node:module";

import * as Compare from "./compare.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json") as { version: string };

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  // Handle [-version] / [-build-info] before delegating to compare, since
  // they short-circuit the rest of the pipeline like the OCaml [Core.Command]
  // does internally.
  if (argv.includes("-version") || argv.includes("--version")) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (argv.includes("-build-info") || argv.includes("--build-info")) {
    process.stdout.write(`patdiff ${pkg.version} (typescript port)\n`);
    return;
  }
  const code = await Compare.main(argv);
  process.exit(code);
};

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${msg}\n`);
  process.exit(2);
});
