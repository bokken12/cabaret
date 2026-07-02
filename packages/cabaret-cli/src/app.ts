import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { parseRefName, type RefName, VERSION } from "cabaret-core";
import type { LocalContext } from "./context.js";

/**
 * Report a command that is wired up but whose behavior is not yet implemented,
 * echoing the parsed flags and arguments so the scaffold is demonstrably live.
 */
function announce(ctx: LocalContext, path: string, values: Readonly<Record<string, unknown>>): void {
  const shown = Object.entries(values)
    .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  ctx.process.stdout.write(`cabaret ${path}${shown ? ` (${shown})` : ""}: not yet implemented\n`);
}

const approve = buildCommand({
  docs: { brief: "Approve a change" },
  parameters: {
    flags: {
      allowEmpty: {
        kind: "boolean",
        brief: "Allow approving an empty change",
        default: false,
      },
      allowOwner: {
        kind: "boolean",
        brief: "Allow approving a change you own",
        default: false,
      },
    },
  },
  func(this: LocalContext, flags: { allowEmpty: boolean; allowOwner: boolean }) {
    announce(this, "approve", flags);
  },
});

const approvers = buildRouteMap({
  docs: { brief: "Manage a change's approvers" },
  routes: {
    add: buildCommand({
      docs: { brief: "Add an approver" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to add", placeholder: "user", parse: String }],
        },
      },
      func(this: LocalContext, _flags: Record<never, never>, user: string) {
        announce(this, "approvers add", { user });
      },
    }),
    remove: buildCommand({
      docs: { brief: "Remove an approver" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to remove", placeholder: "user", parse: String }],
        },
      },
      func(this: LocalContext, _flags: Record<never, never>, user: string) {
        announce(this, "approvers remove", { user });
      },
    }),
  },
});

const create = buildCommand({
  docs: { brief: "Create a change based on the current change" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "name for the new change",
          placeholder: "change",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      parent: {
        kind: "parsed",
        parse: String,
        brief: "Set the new change's parent (exclusive with --child)",
        optional: true,
      },
      child: {
        kind: "parsed",
        parse: String,
        brief: "Set the new change's child (exclusive with --parent)",
        optional: true,
      },
    },
  },
  func(this: LocalContext, flags: { parent?: string; child?: string }, change?: string) {
    announce(this, "create", { change, ...flags });
  },
});

const gh = buildRouteMap({
  docs: { brief: "GitHub integration" },
  routes: {
    pull: buildCommand({
      docs: { brief: "Pull PR activity from GitHub" },
      parameters: {},
      func(this: LocalContext) {
        announce(this, "gh pull", {});
      },
    }),
    push: buildCommand({
      docs: { brief: "Push PR activity to GitHub" },
      parameters: {},
      func(this: LocalContext) {
        announce(this, "gh push", {});
      },
    }),
  },
});

const glab = buildRouteMap({
  docs: { brief: "GitLab integration" },
  routes: {
    pull: buildCommand({
      docs: { brief: "Pull MR activity from GitLab" },
      parameters: {},
      func(this: LocalContext) {
        announce(this, "glab pull", {});
      },
    }),
    push: buildCommand({
      docs: { brief: "Push MR activity to GitLab" },
      parameters: {},
      func(this: LocalContext) {
        announce(this, "glab push", {});
      },
    }),
  },
});

const land = buildCommand({
  docs: { brief: "Land a change (if fully reviewed)" },
  parameters: {},
  func(this: LocalContext) {
    announce(this, "land", {});
  },
});

const log = buildCommand({
  docs: { brief: "Show a log of actions on a change" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to inspect (defaults to current)",
          placeholder: "change",
          parse: parseRefName,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: RefName) {
    const backend = await this.backend();
    this.process.stdout.write(await backend.readLog(change ?? (await backend.currentBranch())));
  },
});

const owners = buildRouteMap({
  docs: { brief: "Manage a change's owners" },
  routes: {
    add: buildCommand({
      docs: { brief: "Add an owner" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to add", placeholder: "user", parse: String }],
        },
      },
      func(this: LocalContext, _flags: Record<never, never>, user: string) {
        announce(this, "owners add", { user });
      },
    }),
    remove: buildCommand({
      docs: { brief: "Remove an owner" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to remove", placeholder: "user", parse: String }],
        },
      },
      func(this: LocalContext, _flags: Record<never, never>, user: string) {
        announce(this, "owners remove", { user });
      },
    }),
  },
});

const rebase = buildCommand({
  docs: {
    brief: "Rebase a change onto its parent",
    fullDescription:
      "Rebase a change onto its parent. Uses `git rebase --onto` internally to " +
      "avoid conflicts, which requires the base recorded in metadata to be valid.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "change to rebase", placeholder: "change", parse: String }],
    },
    flags: {
      allowInvalidBase: {
        kind: "boolean",
        brief: "Skip --onto, for when history was changed outside Cabaret",
        default: false,
      },
    },
  },
  func(this: LocalContext, flags: { allowInvalidBase: boolean }, change: string) {
    announce(this, "rebase", { change, ...flags });
  },
});

const rename = buildCommand({
  docs: { brief: "Rename a change and its underlying branch atomically" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change's old name", placeholder: "old", parse: String },
        { brief: "change's new name", placeholder: "new", parse: String },
      ],
    },
  },
  func(this: LocalContext, _flags: Record<never, never>, old: string, next: string) {
    announce(this, "rename", { old, new: next });
  },
});

const reparent = buildCommand({
  docs: {
    brief: "Update a change's parent",
    fullDescription:
      "Update a change's parent. This is a metadata/log change only, and does not " +
      "touch code without a subsequent `rebase`.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change to reparent", placeholder: "change", parse: parseRefName },
        { brief: "the new parent", placeholder: "parent", parse: parseRefName },
      ],
    },
  },
  // TODO: validate that `change` and `parent` name real changes before logging.
  async func(this: LocalContext, _flags: Record<never, never>, change: RefName, parent: RefName) {
    const backend = await this.backend();
    await backend.appendLog(change, {
      timestamp: this.now(),
      user: await backend.currentUser(),
      action: `set-parent ${parent}`,
    });
  },
});

const review = buildCommand({
  docs: { brief: "Mark files of a change as reviewed" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "change to review", placeholder: "change", parse: String }],
    },
    flags: {
      revision: {
        kind: "parsed",
        parse: String,
        brief: "Mark as reviewed at a specific revision",
        optional: true,
      },
    },
  },
  func(this: LocalContext, flags: { revision?: string }, change: string) {
    announce(this, "review", { change, ...flags });
  },
});

const todos = buildCommand({
  docs: { brief: "Show TODOs in a change's diff" },
  parameters: {
    flags: {
      for: {
        kind: "parsed",
        parse: String,
        brief: "Show TODOs for another user (defaults to self)",
        optional: true,
      },
      all: {
        kind: "boolean",
        brief: "Show TODOs for all users",
        default: false,
      },
    },
  },
  func(this: LocalContext, flags: { for?: string; all: boolean }) {
    announce(this, "todos", flags);
  },
});

const routes = buildRouteMap({
  docs: {
    brief: "Diff-based distributed code review built on top of git",
  },
  routes: {
    approve,
    approvers,
    create,
    gh,
    glab,
    land,
    log,
    owners,
    rebase,
    rename,
    reparent,
    review,
    todos,
  },
});

export const app = buildApplication(routes, {
  name: "cabaret",
  versionInfo: { currentVersion: VERSION },
  // Display flags as kebab-case (matching the CLI-wide convention) while still
  // accepting the camelCase spelling of each flag name.
  scanner: { caseStyle: "allow-kebab-for-camel" },
});
