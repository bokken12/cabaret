import { buildCommand } from "@stricli/core";
import { todoDoc, todoPage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { writeDoc } from "./shared.js";

export const todo = buildCommand({
  docs: { brief: "Show the changes awaiting your attention" },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    const backend = await this.backend();
    const page = await todoPage(backend);
    writeDoc(this, todoDoc(page));
  },
});
