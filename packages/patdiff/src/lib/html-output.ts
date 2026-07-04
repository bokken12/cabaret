/** Node-aware HTML output: implements [mtime] by [stat]ing the file from disk. */

import * as fs from "node:fs";
import type * as FileName from "../kernel/file-name.js";
import { realNameExn } from "../kernel/file-name.js";
import * as KernelHtml from "../kernel/html-output.js";
import type { S } from "../kernel/output.js";
import { err, type OrError, ok } from "../shared/result.js";

export * from "../kernel/html-output.js";

export const nodeMtime: KernelHtml.Mtime = {
  mtime: (file: FileName.FileName): OrError<Date> => {
    try {
      const stats = fs.statSync(realNameExn(file));
      return ok(stats.mtime);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  },
};

export const withNodeMtime: S = KernelHtml.make(nodeMtime);
