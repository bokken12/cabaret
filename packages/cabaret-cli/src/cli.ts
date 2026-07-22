#!/usr/bin/env node
import { run } from "@stricli/core";
import { app } from "./app.js";
import { buildContext } from "./context.js";

// A downstream pager closing the pipe ends the reader's interest, not the
// process's good standing; anything else stays fatal.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

await run(app, process.argv.slice(2), buildContext(process));
