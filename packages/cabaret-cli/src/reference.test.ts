import { type Application, type CommandContext, generateHelpTextForAllCommands } from "@stricli/core";
import { expect, test } from "vitest";
import { app } from "./app.js";

const HEADER =
  "# Cabaret CLI Reference\n\n" +
  "<!-- Generated from the command tree; do not edit by hand. Regenerate with `pnpm test -u`. -->";

/** Dump each command's help under a Markdown heading whose level is its route depth. */
function renderReference(): string {
  // Help generation only reads docs and never invokes command funcs, so
  // widening the context type away from LocalContext is safe.
  const sections = generateHelpTextForAllCommands(app as Application<CommandContext>).map(
    ([route, help]) => `${"#".repeat(route.split(" ").length)} ${route}\n\n${help.trimEnd()}`,
  );
  return `${HEADER}\n\n${sections.join("\n\n")}\n`;
}

// Snapshots the CLI surface to a committed file so the command tree evolves
// through reviewable diffs.
test("CLI reference matches cli-reference.md", async () => {
  await expect(renderReference()).toMatchFileSnapshot("../cli-reference.md");
});
