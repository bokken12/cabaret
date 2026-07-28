#!/usr/bin/env node
import { buildApplication, buildCommand, type CommandContext, run } from "@stricli/core";

// Placeholder root; becomes a buildRouteMap once there are real commands.
const root = buildCommand({
  func(this: CommandContext): void {
    this.process.stdout.write("cabaret: no commands yet\n");
  },
  parameters: {},
  docs: { brief: "Cabaret command-line interface" },
});

const app = buildApplication(root, { name: "cabaret" });

await run(app, process.argv.slice(2), { process });
