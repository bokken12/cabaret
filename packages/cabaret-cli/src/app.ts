import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import {
  brain,
  changeBase,
  type FilePath,
  formatLogEntry,
  parseFilePath,
  parseRefName,
  type RefName,
  type UserName,
  userName,
  VERSION,
} from "cabaret-core";
import type { LocalContext } from "./context.js";

/** Parse a `--for` user, rejecting the empty string. */
function parseUser(raw: string): UserName {
  if (raw === "") {
    throw new Error("user must be nonempty");
  }
  return userName(raw);
}

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

const diff = buildCommand({
  docs: {
    brief: "Show the diff of a change left to review for a file",
    fullDescription:
      "Show the diff of a file left to review, given the reviewer's brain: the " +
      "full base → tip diff when the file is unreviewed, or the diff from the " +
      "previously reviewed tip when the base is unchanged.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "file to diff", placeholder: "file", parse: parseFilePath }],
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to diff (defaults to current)",
        optional: true,
      },
      for: {
        kind: "parsed",
        parse: parseUser,
        brief: "Show the diff for another user (defaults to self)",
        optional: true,
      },
    },
  },
  // TODO: normalize the file argument to a repo-relative path so lookups made
  // from a subdirectory name the same file the log does.
  async func(this: LocalContext, flags: { change?: RefName; for?: UserName }, file: FilePath) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    const user = flags.for ?? (await backend.currentUser());
    const entries = await backend.readLog(change);
    const base = await changeBase(backend, change, entries);
    // Pin to the branch namespace so a same-named tag cannot shadow the
    // change's tip.
    const tip = await backend.resolveCommit(`refs/heads/${change}`);
    const reviewed = brain(entries, user).get(file);
    if (reviewed !== undefined && reviewed.base !== base) {
      // TODO: implement 4-way diffs (Iron's diff4) so review can continue
      // across a rebase.
      throw new Error(
        `4-way diff not yet implemented: ${file} was reviewed at base ${reviewed.base}, ` +
          `but the change's base is now ${base}`,
      );
    }
    this.process.stdout.write(await backend.diffFile(reviewed?.tip ?? base, tip, file));
  },
});

const forget = buildCommand({
  docs: {
    brief: "Forget files of a change, so they need review again",
    fullDescription:
      "Forget files of a change, so they need review again. Appends one " +
      "`forget` entry per file to the change's log.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: { brief: "files to forget", placeholder: "file", parse: parseFilePath },
      minimum: 1,
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to forget in (defaults to current)",
        optional: true,
      },
    },
  },
  // TODO: validate that `change` names a real change before logging.
  async func(this: LocalContext, flags: { change?: RefName }, ...files: FilePath[]) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    const user = await backend.currentUser();
    await backend.appendLog(
      change,
      files.map((file) => ({
        timestamp: this.now(),
        user,
        action: { kind: "forget" as const, file },
      })),
    );
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
    const entries = await backend.readLog(change ?? (await backend.currentBranch()));
    this.process.stdout.write(entries.map(formatLogEntry).join(""));
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
    await backend.appendLog(change, [
      {
        timestamp: this.now(),
        user: await backend.currentUser(),
        action: { kind: "set-parent", parent },
      },
    ]);
  },
});

const review = buildCommand({
  docs: {
    brief: "Mark files of a change as reviewed",
    fullDescription:
      "Mark files of a change as reviewed. Appends one `review` entry per file " +
      "recording the base and tip of the reviewed diff, where the base is the " +
      "last revision shared with the change's parent.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: { brief: "files to mark as reviewed", placeholder: "file", parse: parseFilePath },
      minimum: 1,
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to review (defaults to current)",
        optional: true,
      },
      tip: {
        kind: "parsed",
        parse: String,
        brief: "Mark as reviewed at this tip revision (defaults to the change's tip)",
        optional: true,
      },
    },
  },
  // TODO: normalize file arguments to repo-relative paths so entries written
  // from a subdirectory name the same files a diff would.
  async func(this: LocalContext, flags: { change?: RefName; tip?: string }, ...files: FilePath[]) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    // Pin the default to the branch namespace so a same-named tag cannot
    // shadow the change's tip.
    const tip = await backend.resolveCommit(flags.tip ?? `refs/heads/${change}`);
    const base = await changeBase(backend, change, await backend.readLog(change));
    const user = await backend.currentUser();
    await backend.appendLog(
      change,
      files.map((file) => ({
        timestamp: this.now(),
        user,
        action: { kind: "review" as const, file, base, tip },
      })),
    );
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
    diff,
    forget,
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
