import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import {
  brain,
  changeBase,
  currentBase,
  currentParent,
  type FilePath,
  formatLogEntry,
  parseFilePath,
  parseRefName,
  type RefName,
  type UserName,
  userName,
  VERSION,
} from "cabaret-core";
import { PatdiffCore } from "patdiff";
import { IsBinary } from "patdiff/kernel";
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
  docs: {
    brief: "Create a change",
    fullDescription:
      "Create a change, initializing its log with a parent and a base. A branch " +
      "that does not exist yet is created at the parent's tip; an existing branch " +
      "is adopted with the last revision shared with the parent as its base. The " +
      "change must not already have a log.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "name for the new change", placeholder: "change", parse: parseRefName }],
    },
    flags: {
      parent: {
        kind: "parsed",
        parse: parseRefName,
        brief: "The new change's parent (defaults to the current branch)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { parent?: RefName }, change: RefName) {
    const backend = await this.backend();
    const parent = flags.parent ?? (await backend.currentBranch());
    if (change === parent) {
      throw new Error(`change cannot be its own parent: ${JSON.stringify(change)}`);
    }
    if ((await backend.readLog(change)).length > 0) {
      throw new Error(`change already has a log: ${JSON.stringify(change)}`);
    }
    const parentTip = await backend.branchTip(parent);
    if (parentTip === undefined) {
      throw new Error(`parent branch does not exist: ${JSON.stringify(parent)}`);
    }
    // Resolve the identity before mutating any ref so a missing git identity
    // fails without leaving a branch behind.
    const user = await backend.currentUser();
    const existing = await backend.branchTip(change);
    // A fresh branch is created at the parent's tip, which is therefore its
    // base; an adopted branch is based where it last shared with the parent.
    let base: typeof parentTip;
    if (existing === undefined) {
      await backend.createBranch(change, parentTip);
      base = parentTip;
    } else {
      base = await backend.mergeBase(parent, change);
    }
    await backend.appendLog(change, [
      { timestamp: this.now(), user, action: { kind: "set-parent", parent } },
      { timestamp: this.now(), user, action: { kind: "set-base", base } },
    ]);
  },
});

/**
 * Render the diff between two versions of `file` with patdiff: ANSI-colored
 * with word-level refinement on a terminal, plain ASCII otherwise. An absent
 * version diffs against the empty file, named /dev/null as in git.
 */
function renderDiff(file: FilePath, prev: string | undefined, next: string | undefined, color: boolean): string {
  if (IsBinary.string(prev ?? "") || IsBinary.string(next ?? "")) {
    return prev === next ? "" : `Binary versions of ${file} differ\n`;
  }
  const prevName = prev === undefined ? "/dev/null" : `old/${file}`;
  const nextName = next === undefined ? "/dev/null" : `new/${file}`;
  const diff = PatdiffCore.withoutUnix.patdiff({
    output: color ? "Ansi" : "Ascii",
    // Unified lines are unsupported in Ascii output.
    produceUnifiedLines: color,
    prev: { name: prevName, text: prev ?? "" },
    next: { name: nextName, text: next ?? "" },
  });
  // patdiff's own global header prints even when no hunks survive (e.g. equal
  // contents), so an empty diff must skip the header here instead.
  return diff === "" ? "" : `${prevName}\n${nextName}\n${diff}\n`;
}

const diff = buildCommand({
  docs: {
    brief: "Show the diff of a change left to review for a file",
    fullDescription:
      "Show the diff of a file left to review, given the reviewer's brain: the " +
      "full base → tip diff when the file is unreviewed, or the diff from the " +
      "previously reviewed tip when that still covers everything left — the " +
      "file is the same at both bases, or the new base took the reviewed " +
      "tip's copy.",
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
      // A moved base still leaves the 2-way diff from the reviewed tip sound
      // in two cases: the base's copy of the file is unchanged (the reviewed
      // diff's start is intact), or the new base's copy equals the reviewed
      // tip's (the whole new diff starts at contents the reviewer knows).
      const [prevBase, nextBase, prevTip] = await Promise.all([
        backend.readFile(reviewed.base, file),
        backend.readFile(base, file),
        backend.readFile(reviewed.tip, file),
      ]);
      if (prevBase !== nextBase && nextBase !== prevTip) {
        // TODO: implement 4-way diffs (Iron's diff4) so review can continue
        // when the base's copy of a reviewed file changes.
        throw new Error(
          `4-way diff not yet implemented: ${file} was reviewed with a different copy ` +
            `at base ${reviewed.base} than at the current base ${base}`,
        );
      }
    }
    const prevCommit = reviewed?.tip ?? base;
    const [prev, next] = await Promise.all([backend.readFile(prevCommit, file), backend.readFile(tip, file)]);
    if (prev === undefined && next === undefined) {
      throw new Error(`${file} exists at neither ${prevCommit} nor ${tip}`);
    }
    // Stricli's process type omits isTTY, but the runtime process underneath has it.
    const color = (this.process.stdout as { isTTY?: boolean }).isTTY === true;
    this.process.stdout.write(renderDiff(file, prev, next, color));
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
    brief: "Rebase a change onto its parent's tip",
    fullDescription:
      "Rebase a change onto its parent's tip, then record the new base in the " +
      "log. Replays only the commits after the change's base (`git rebase " +
      "--onto`), so commits the change shares with an old version of the parent " +
      "are never reapplied.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to rebase (defaults to current)",
          placeholder: "change",
          parse: parseRefName,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: RefName) {
    const backend = await this.backend();
    const target = change ?? (await backend.currentBranch());
    const entries = await backend.readLog(target);
    const parent = currentParent(entries);
    if (parent === undefined) {
      throw new Error(`change has no parent: ${JSON.stringify(target)}`);
    }
    const onto = await backend.branchTip(parent);
    if (onto === undefined) {
      throw new Error(`parent branch does not exist: ${JSON.stringify(parent)}`);
    }
    const base = await changeBase(backend, target, entries);
    // Replay the change's own commits onto the parent's tip. When the change
    // already sits there (base === onto), whether because it was just rebased
    // or an out-of-band `git rebase` put it there, there is nothing to replay.
    if (base !== onto) {
      // Record the base only after a clean rebase: if the rebase stops on
      // conflicts and the user finishes it with git, this line never runs and
      // the stale stored base loses to the merge-base with the parent.
      await backend.rebaseOnto(target, base, onto);
    }
    // Pin the base to the parent's tip so a later parent rewrite cannot slide
    // it back to an ancestor and pull the parent's commits into the diff.
    if (currentBase(entries) !== onto) {
      await backend.appendLog(target, [
        { timestamp: this.now(), user: await backend.currentUser(), action: { kind: "set-base", base: onto } },
      ]);
    }
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
