#!/usr/bin/env node
/** Post-build step:
 *   1. Copy [src/bin/patdiff-git-wrapper] into [dist/bin].
 *   2. Mark CLI entry points executable. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcWrapper = path.join(root, "src", "bin", "patdiff-git-wrapper");
const distBin = path.join(root, "dist", "bin");
const distWrapper = path.join(distBin, "patdiff-git-wrapper");
const distMain = path.join(distBin, "main.js");

fs.mkdirSync(distBin, { recursive: true });

if (fs.existsSync(srcWrapper)) {
  fs.copyFileSync(srcWrapper, distWrapper);
  fs.chmodSync(distWrapper, 0o755);
} else {
  console.warn(`postbuild: ${srcWrapper} not found, skipping copy`);
}

if (fs.existsSync(distMain)) {
  fs.chmodSync(distMain, 0o755);
}
