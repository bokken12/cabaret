import { buildCommand } from "@stricli/core";
import { homeDoc, homePage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { writeDoc } from "./shared.js";

export const home = buildCommand({
  docs: { brief: "Show your reviews, changes, and workspaces" },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    const backend = await this.backend();
    const page = await homePage(backend);
    writeDoc(this, homeDoc(page, this.now()));
  },
});
