import { buildCommand, buildRouteMap } from "@stricli/core";
import { addChangeWorkspace, changeWorkspace, removeChangeWorkspace, UserError } from "cabaret-core";
import { workspacesDoc, workspacesPage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { writeDoc } from "./shared.js";

const changePositional = {
  kind: "tuple",
  parameters: [{ brief: "change the workspace holds", placeholder: "change", parse: String }],
} as const;

const list = buildCommand({
  docs: { brief: "List this repository's workspaces" },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    writeDoc(this, workspacesDoc(await workspacesPage(await this.backend())));
  },
});

const add = buildCommand({
  docs: {
    brief: "Create a workspace with a change checked out",
    fullDescription:
      "Create a workspace — a new working tree — with the change checked " +
      "out, beside the primary workspace. Prints where it went.",
  },
  parameters: {
    positional: changePositional,
    flags: {
      at: {
        kind: "parsed",
        parse: String,
        brief: "Where to create the workspace (defaults beside the primary workspace)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { at?: string }, change: string) {
    const backend = await this.backend();
    const path = await addChangeWorkspace(backend, backend.parseName(change), flags.at);
    this.process.stdout.write(`${path}\n`);
  },
});

const remove = buildCommand({
  docs: {
    brief: "Remove the workspace holding a change",
    fullDescription:
      "Remove the workspace holding the change. The change itself — its code and its log — is untouched.",
  },
  parameters: {
    positional: changePositional,
    flags: {
      evenThoughDirty: {
        kind: "boolean",
        brief: "Remove the workspace even though it has uncommitted changes, discarding them",
        default: false,
      },
    },
  },
  async func(this: LocalContext, flags: { evenThoughDirty: boolean }, change: string) {
    const backend = await this.backend();
    const path = await removeChangeWorkspace(backend, backend.parseName(change), flags.evenThoughDirty);
    this.process.stdout.write(`removed ${path}\n`);
  },
});

const dir = buildCommand({
  docs: { brief: "Print the directory of the workspace holding a change" },
  parameters: { positional: changePositional },
  async func(this: LocalContext, _flags: Record<never, never>, change: string) {
    const backend = await this.backend();
    const workspace = await changeWorkspace(backend, backend.parseName(change));
    if (workspace === undefined) {
      throw new UserError(`change has no workspace: ${JSON.stringify(change)}`);
    }
    this.process.stdout.write(`${workspace.path}\n`);
  },
});

export const workspace = buildRouteMap({
  docs: { brief: "Manage workspaces: working trees each holding a checked-out change" },
  routes: { list, add, remove, dir },
});
