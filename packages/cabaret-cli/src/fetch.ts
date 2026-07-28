import { buildCommand, type Command, type CommandContext } from "@stricli/core";
import { Backend, ShellGit } from "cabaret-core";

export const fetchCommand: Command<CommandContext> = buildCommand({
  async func(): Promise<void> {
    const backend = new Backend(new ShellGit());
    await backend.fetch();
  },
  parameters: {},
  docs: { brief: "Fetch changes from the Git remote" },
});
