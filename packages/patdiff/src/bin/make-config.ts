/** [-make-config FILE] flag handler: writes a default sexp configuration file.
 *  Translation of OCaml's [Patdiff_bin.Make_config]. */

import * as fs from "node:fs";
import * as readline from "node:readline";

import { Configuration } from "../lib/patdiff.js";

export const doc = "FILE Write default configuration file";

const promptOverwrite = async (filename: string): Promise<boolean> => {
  process.stdout.write(`${filename} already exists. Overwrite? (y/n) `);
  const rl = readline.createInterface({ input: process.stdin });
  const line = await new Promise<string>((resolve) => {
    rl.once("line", (l) => {
      rl.close();
      resolve(l);
    });
    rl.once("close", () => resolve(""));
  });
  const resp = line.toLowerCase();
  return resp === "y" || resp === "yes";
};

export const main = async (filename: string): Promise<void> => {
  let proceed = true;
  if (fs.existsSync(filename)) {
    proceed = await promptOverwrite(filename);
  }
  if (!proceed) {
    process.stdout.write("Configuration file not written!\n");
    process.exit(1);
  }
  Configuration.saveDefault({ filename });
  process.stdout.write(`Default configuration written to ${filename}\n`);
};
