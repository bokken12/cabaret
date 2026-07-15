import { buildApplication, buildCommand, buildRouteMap, text_en } from "@stricli/core";
import {
  assertChangeExists,
  assertNotLanded,
  type Backend,
  brain,
  type ConfigScope,
  changeBase,
  changeTip,
  conflictMarkers,
  createChange,
  currentSelf,
  defaultContext,
  type FilePath,
  formatLogEntry,
  type LogEntry,
  landAsConfigured,
  landChain,
  NotOwnerError,
  newTodos,
  type PullEvent,
  parseContext,
  parseFilePath,
  parseRefName,
  pullForge,
  pullTrackedChange,
  pushChange,
  type RefName,
  type ReviewSpan,
  readConfig,
  rebaseChain,
  rebaseChange,
  rebasedView,
  remainingSpans,
  renameChange,
  renderDiff,
  renderDiff4,
  reparentChange,
  resolveRange,
  reviewSpans,
  type Setting,
  settings,
  syncedForgeChange,
  type Todo,
  transferChange,
  UnsatisfiedObligationsError,
  UserError,
  type UserName,
  userName,
  VERSION,
} from "cabaret-core";
import { applySetup, auditSetup, declinedScopes, type SetupAudit } from "cabaret-node";
import { type Doc, docText, showDoc, showPage, todoDoc, todoPage } from "cabaret-views";
import type { LocalContext } from "./context.js";

/** Parse a user argument, rejecting the empty string. */
function parseUser(raw: string): UserName {
  if (raw === "") {
    throw new UserError("user must be nonempty");
  }
  return userName(raw);
}

/**
 * What a rebase or land applies to: one change, or an `ancestor..descendant`
 * range of them. As with git's `upstream..branch`, the left endpoint is
 * excluded: it bounds the range and is never itself operated on.
 */
type ChangeSpec =
  | { readonly kind: "one"; readonly change: RefName }
  | { readonly kind: "range"; readonly ancestor: RefName; readonly descendant: RefName };

function parseChangeSpec(raw: string): ChangeSpec {
  const parts = raw.split("..");
  if (parts.length === 1) {
    return { kind: "one", change: parseRefName(raw) };
  }
  const [ancestor, descendant] = parts;
  // "a...b" splits into "a" and ".b": the stray leading dot, like an empty
  // endpoint or a second "..", marks a malformed range.
  if (parts.length !== 2 || !ancestor || !descendant || descendant.startsWith(".")) {
    throw new UserError(`not a change or ancestor..descendant range: ${JSON.stringify(raw)}`);
  }
  return { kind: "range", ancestor: parseRefName(ancestor), descendant: parseRefName(descendant) };
}

/** The escape hatch for commands that `requireOwner` guards. */
const evenThoughNotOwner = {
  kind: "boolean",
  brief: "Proceed even though you do not own the change",
  default: false,
} as const;

/** The escape hatch for the review-obligations check on `land`. */
const evenThoughUnreviewed = {
  kind: "boolean",
  brief: "Land even though review obligations are unsatisfied",
  default: false,
} as const;

/** A `UserError`'s message, with this frontend's remedy attached to the overridable checks. */
function userMessage(error: UserError): string {
  if (error instanceof NotOwnerError) {
    return `${error.message}; pass --even-though-not-owner to override`;
  }
  if (error instanceof UnsatisfiedObligationsError) {
    return `review obligations are unsatisfied; pass --even-though-unreviewed to override:\n${error.details.join("\n")}`;
  }
  return error.message;
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

/** Append one reviewer entry to `change`'s log. */
async function recordReviewer(
  ctx: LocalContext,
  change: RefName | undefined,
  reviewer: UserName,
  kind: "add-reviewer" | "remove-reviewer",
): Promise<void> {
  const backend = await ctx.backend();
  const target = change ?? (await backend.currentBranch());
  const entries = await backend.readLog(target);
  assertChangeExists(target, entries);
  // A landed change is frozen: its obligations were settled when it landed.
  assertNotLanded(target, entries);
  await backend.appendLog(target, [
    { timestamp: ctx.now(), user: await backend.currentUser(), action: { kind, reviewer } },
  ]);
}

const reviewers = buildRouteMap({
  docs: { brief: "Manage a change's reviewers" },
  routes: {
    add: buildCommand({
      docs: {
        brief: "Add a reviewer to a change",
        fullDescription:
          "Add a reviewer to a change. A reviewer owes review of the change's " +
          "whole diff, as the owner does; `show` displays the reviewers, and " +
          "`pull`/`push` sync them with the forge.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to add", placeholder: "user", parse: parseUser }],
        },
        flags: {
          change: {
            kind: "parsed",
            parse: parseRefName,
            brief: "Change to add the reviewer to (defaults to current)",
            optional: true,
          },
        },
      },
      async func(this: LocalContext, flags: { change?: RefName }, reviewer: UserName) {
        await recordReviewer(this, flags.change, reviewer, "add-reviewer");
      },
    }),
    remove: buildCommand({
      docs: { brief: "Remove a reviewer from a change" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to remove", placeholder: "user", parse: parseUser }],
        },
        flags: {
          change: {
            kind: "parsed",
            parse: parseRefName,
            brief: "Change to remove the reviewer from (defaults to current)",
            optional: true,
          },
        },
      },
      async func(this: LocalContext, flags: { change?: RefName }, reviewer: UserName) {
        await recordReviewer(this, flags.change, reviewer, "remove-reviewer");
      },
    }),
  },
});

/** Parse a comment-text argument, rejecting the empty string. */
function parseCommentText(raw: string): string {
  if (raw === "") {
    throw new UserError("comment must be nonempty");
  }
  return raw;
}

const comment = buildCommand({
  docs: {
    brief: "Add a comment to a change",
    fullDescription:
      "Add a comment to a change. Appends one `comment` entry to the change's " + "log; `show` displays the comments.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the comment text", placeholder: "text", parse: parseCommentText }],
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to comment on (defaults to current)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: RefName }, text: string) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    // Logs are only ever started by `create`; appending to a missing one
    // would conjure a change out of thin air.
    assertChangeExists(change, await backend.readLog(change));
    await backend.appendLog(change, [
      { timestamp: this.now(), user: await backend.currentUser(), action: { kind: "comment", text } },
    ]);
  },
});

/** Column width that aligns values after the longest setting name. */
const settingNameWidth = Math.max(...settings.map((s) => s.name.length));

/** The git-style scope flags every config subcommand takes. */
const scopeFlags = {
  global: { kind: "boolean", brief: "Use the person's global git config", default: false },
  local: { kind: "boolean", brief: "Use this repository's git config", default: false },
} as const;

interface ScopeFlags {
  readonly global: boolean;
  readonly local: boolean;
}

/** The scope `flags` pick, or undefined when they pick none. */
function flaggedScope(flags: ScopeFlags): ConfigScope | undefined {
  if (flags.global && flags.local) {
    throw new UserError("pass at most one of --global and --local");
  }
  return flags.global ? "global" : flags.local ? "local" : undefined;
}

/** The scope a write to `setting` targets: the flagged one, or the setting's home. */
function writeScope(setting: Setting, flags: ScopeFlags): ConfigScope {
  return flaggedScope(flags) ?? setting.scope;
}

/** Render `setting`'s values as one line: `scope`'s alone, or all scopes merged. */
async function shownValue(backend: Backend, setting: Setting, scope: ConfigScope | undefined): Promise<string> {
  const values = await backend.configAll(setting.key, scope);
  if (values.length > 0) {
    return values.join(", ");
  }
  // What a setting defaults to only holds for the merged view; one scope's
  // gap may be filled by the other, so it is just unset.
  if (scope !== undefined) {
    return "(unset)";
  }
  return setting.fallback !== undefined ? `${setting.fallback} (default)` : "(none)";
}

/** The command for single-valued `setting`: show bare, set with a value, clear with --unset. */
function settingCommand(setting: Setting) {
  return buildCommand({
    docs: { brief: setting.brief },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          {
            brief: "value to set (shows the current value when omitted)",
            placeholder: "value",
            parse: String,
            optional: true,
          },
        ],
      },
      flags: {
        ...scopeFlags,
        unset: { kind: "boolean", brief: "Unset the setting, restoring its default", default: false },
      },
    },
    async func(this: LocalContext, flags: ScopeFlags & { unset: boolean }, value?: string) {
      const backend = await this.backend();
      if (flags.unset) {
        if (value !== undefined) {
          throw new UserError("pass a value or --unset, not both");
        }
        const scope = writeScope(setting, flags);
        if (!(await backend.configUnset(setting.key, scope))) {
          throw new UserError(`git config ${setting.key} has no ${scope} value`);
        }
      } else if (value !== undefined) {
        await backend.configSet(setting.key, setting.parse(value), writeScope(setting, flags));
      } else {
        this.process.stdout.write(`${await shownValue(backend, setting, flaggedScope(flags))}\n`);
      }
    },
  });
}

/** The route map for multi-valued `setting`: values are added and removed, not set. */
function settingRouteMap(setting: Setting) {
  return buildRouteMap({
    docs: { brief: setting.brief },
    routes: {
      add: buildCommand({
        docs: { brief: "Add a value" },
        parameters: {
          positional: {
            kind: "tuple",
            parameters: [{ brief: "value to add", placeholder: "value", parse: String }],
          },
          flags: scopeFlags,
        },
        async func(this: LocalContext, flags: ScopeFlags, raw: string) {
          const scope = writeScope(setting, flags);
          const value = setting.parse(raw);
          const backend = await this.backend();
          if ((await backend.configAll(setting.key, scope)).includes(value)) {
            throw new UserError(
              `git config ${setting.key} already contains ${JSON.stringify(value)} in ${scope} config`,
            );
          }
          await backend.configAdd(setting.key, value, scope);
        },
      }),
      remove: buildCommand({
        docs: { brief: "Remove a value" },
        parameters: {
          positional: {
            kind: "tuple",
            parameters: [{ brief: "value to remove", placeholder: "value", parse: String }],
          },
          flags: scopeFlags,
        },
        async func(this: LocalContext, flags: ScopeFlags, value: string) {
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if (!(await backend.configUnset(setting.key, scope, value))) {
            throw new UserError(`git config ${setting.key} has no ${scope} value ${JSON.stringify(value)}`);
          }
        },
      }),
      clear: buildCommand({
        docs: { brief: "Remove every value" },
        parameters: { flags: scopeFlags },
        async func(this: LocalContext, flags: ScopeFlags) {
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if (!(await backend.configUnset(setting.key, scope))) {
            throw new UserError(`git config ${setting.key} has no ${scope} value`);
          }
        },
      }),
    },
  });
}

const config = buildRouteMap({
  docs: {
    brief: "Manage Cabaret's settings",
    fullDescription:
      "Manage Cabaret's settings, stored as `cabaret.*` git config keys. " +
      "Each setting is a command: bare it shows the value, with a value it " +
      "sets it. Without --global or --local, settings of the person (alias, " +
      "context) go to global config, and settings of the repository " +
      "(land-method, land-via) to local config.",
  },
  routes: {
    list: buildCommand({
      docs: { brief: "Show every setting" },
      parameters: { flags: scopeFlags },
      async func(this: LocalContext, flags: ScopeFlags) {
        const scope = flaggedScope(flags);
        const backend = await this.backend();
        for (const setting of settings) {
          const shown = await shownValue(backend, setting, scope);
          this.process.stdout.write(`${setting.name.padEnd(settingNameWidth)}  ${shown}\n`);
        }
      },
    }),
    ...Object.fromEntries(settings.map((s) => [s.name, s.multi ? settingRouteMap(s) : settingCommand(s)])),
  },
});

const create = buildCommand({
  docs: {
    brief: "Create a change",
    fullDescription:
      "Create a change, initializing its log with a parent, a base, and an " +
      "owner. A branch that does not exist yet is created at the parent's " +
      "tip; an existing branch is adopted with the last revision shared with " +
      "the parent as its base. The change must not already exist.",
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
      owner: {
        kind: "parsed",
        parse: parseUser,
        brief: "The new change's owner (defaults to you)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { parent?: RefName; owner?: UserName }, change: RefName) {
    const backend = await this.backend();
    await createChange(backend, this.now, change, flags.parent ?? (await backend.currentBranch()), flags.owner);
  },
});

const dev = buildRouteMap({
  docs: { brief: "Utilities for developing Cabaret" },
  routes: {
    wipe: buildCommand({
      docs: {
        brief: "Delete all review state",
        fullDescription:
          "Delete the review state this repository holds: every change's log " +
          "and the fetched copies of origin's logs. Branches and commits " +
          "stay, and origin keeps its logs, so `cabaret sync` restores them. " +
          "--remote deletes origin's logs too, for every user of the " +
          "repository.",
      },
      parameters: {
        flags: {
          remote: {
            kind: "boolean",
            brief: "Also delete every log on origin (unrecoverable)",
            default: false,
          },
        },
      },
      async func(this: LocalContext, flags: { remote: boolean }) {
        const backend = await this.backend();
        const wiped = await backend.wipeReviewState();
        this.process.stdout.write(`wiped the logs of ${wiped.length} change${wiped.length === 1 ? "" : "s"}\n`);
        if (flags.remote) {
          const origin = await backend.wipeOriginLogs();
          this.process.stdout.write(
            `wiped the logs of ${origin.length} change${origin.length === 1 ? "" : "s"} on origin\n`,
          );
        }
      },
    }),
  },
});

const diff = buildCommand({
  docs: {
    brief: "Show the diff of a change left to review for a file",
    fullDescription:
      "Show the diff of a file left to review, given the reviewer's brain: the " +
      "full base → tip diff when the file is unreviewed, the diff from the " +
      "previously reviewed tip when that still covers everything left — the " +
      "file is the same at both bases, or the new base took the reviewed " +
      "tip's copy — or a 4-way diff of the reviewed and current diffs when " +
      "the base's copy changed underneath the review. The diff a land merge " +
      "brings in was reviewed in the landed change, so it is skipped: what " +
      "prints is one diff per span of history between land merges.",
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
      context: {
        kind: "parsed",
        parse: parseContext,
        brief: `Lines of context around each hunk, -1 for whole files (defaults to git config cabaret.context, or ${defaultContext})`,
        optional: true,
      },
    },
  },
  // TODO: normalize the file argument to a repo-relative path so lookups made
  // from a subdirectory name the same file the log does.
  async func(this: LocalContext, flags: { change?: RefName; for?: UserName; context?: number }, file: FilePath) {
    const backend = await this.backend();
    // Config is read even when the flag preempts it, so a misconfigured
    // cabaret.* key fails the same way on every invocation.
    const context = flags.context ?? (await readConfig(backend)).context;
    const change = flags.change ?? (await backend.currentBranch());
    const user = flags.for ?? (await backend.currentUser());
    const entries = await backend.readLog(change);
    const base = await changeBase(backend, change, entries);
    // Pin to the branch namespace so a same-named tag cannot shadow the
    // change's tip.
    const tip = await backend.resolveCommit(`refs/heads/${change}`);
    const reviewed = brain(entries, user).get(file);
    // Stricli's process type omits isTTY, but the runtime process underneath has it.
    const color = (this.process.stdout as { isTTY?: boolean }).isTTY === true;
    if (reviewed !== undefined && reviewed.base !== base) {
      const view = await rebasedView(backend, file, reviewed, base, tip);
      if (view.kind === "two") {
        this.process.stdout.write(renderDiff(file, view.prev, view.next, color, context));
      } else {
        const rendered = renderDiff4({ file, revs: view.revs, contents: view.contents, color, context });
        this.process.stdout.write(rendered.length === 0 ? "" : `${rendered.map((line) => line.text).join("\n")}\n`);
      }
      return;
    }
    let spans: readonly ReviewSpan[];
    if (reviewed !== undefined && !(await backend.isAncestor(reviewed.tip, tip))) {
      // The tip was rewritten out from under the review, so the reviewed tip
      // cannot be placed among the first-parent spans; diffing from its
      // contents still shows exactly what the reviewer has not seen.
      spans = [{ start: reviewed.tip, end: tip }];
    } else {
      spans = await reviewSpans(backend, base, tip);
      if (reviewed !== undefined) {
        spans = await remainingSpans(backend, spans, reviewed.tip);
      }
    }
    // Base and tip join the existence check even when review or a land merge
    // drops them from the spans: a file present anywhere in the change is
    // simply done (empty output), while a name found nowhere is an error.
    const revs = [...new Set([...spans.flatMap(({ start, end }) => [start, end]), base, tip])];
    const contents = new Map(
      await Promise.all(revs.map(async (rev) => [rev, await backend.readFile(rev, file)] as const)),
    );
    if (revs.every((rev) => contents.get(rev) === undefined)) {
      throw new UserError(`${file} exists at none of ${revs.join(", ")}`);
    }
    const rendered = spans
      .map(({ start, end }) => renderDiff(file, contents.get(start), contents.get(end), color, context))
      .filter((diff) => diff !== "");
    // A blank line between spans, since consecutive diffs of one file would
    // otherwise run together.
    this.process.stdout.write(rendered.join("\n"));
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
  async func(this: LocalContext, flags: { change?: RefName }, ...files: FilePath[]) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    // Logs are only ever started by `create`; appending to a missing one
    // would conjure a change out of thin air.
    assertChangeExists(change, await backend.readLog(change));
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

/** Report one thing a pull did, in the CLI's voice. */
function reportPullEvent(context: LocalContext, locator: string, event: PullEvent): void {
  const name = `${locator}#${event.id}`;
  switch (event.kind) {
    case "imported":
      context.process.stdout.write(
        `imported ${name} as ${JSON.stringify(event.change)} with ` +
          `${event.comments} comment${event.comments === 1 ? "" : "s"}\n`,
      );
      return;
    case "skipped":
      context.process.stderr.write(`warning: skipping ${name} (${JSON.stringify(event.change)}): ${event.reason}\n`);
      return;
    case "pulled":
      if (event.landed) {
        context.process.stdout.write(`${name} was merged; recorded the land\n`);
      }
      if (event.parent !== undefined) {
        context.process.stdout.write(`${name} was retargeted; reparented onto ${JSON.stringify(event.parent)}\n`);
      }
      if (event.reviewers > 0) {
        context.process.stdout.write(
          `updated ${event.reviewers} reviewer${event.reviewers === 1 ? "" : "s"} from ${name}\n`,
        );
      }
      context.process.stdout.write(`pulled ${event.comments} comment${event.comments === 1 ? "" : "s"} from ${name}\n`);
      return;
    case "pruned":
      context.process.stdout.write(`${name} was closed; removed unreviewed change ${JSON.stringify(event.change)}\n`);
      return;
  }
}

const pull = buildCommand({
  docs: {
    brief: "Pull activity from the forge",
    fullDescription:
      "Pull activity from the forge: import every open forge change that is " +
      "not yet a change — owned by its author, parented on the branch it " +
      "merges into — import forge comments into change logs, and record " +
      "merged forge changes as landing their changes. Pulls every unlanded " +
      "change with a forge change; --change restricts it to one.",
  },
  parameters: {
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Only change to pull",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: RefName }) {
    const backend = await this.backend();
    const forge = await this.forge();
    if (flags.change !== undefined) {
      const change = flags.change;
      await backend.syncLog(change);
      const entries = await backend.readLog(change);
      assertChangeExists(change, entries);
      const forgeChange = await syncedForgeChange(backend, this.now, forge, change, entries);
      if (forgeChange === undefined) {
        throw new UserError(
          `no forge change for ${JSON.stringify(change)} on ${forge.locator}; run \`cabaret push\` first`,
        );
      }
      const pulled = await pullTrackedChange(backend, this.now, forge, change, entries, forgeChange);
      reportPullEvent(this, forge.locator, { kind: "pulled", id: forgeChange.id, change, ...pulled });
      return;
    }
    const { open } = await pullForge(backend, this.now, forge, (event) => reportPullEvent(this, forge.locator, event));
    this.process.stdout.write(`synced ${forge.locator}: ${open} open forge change${open === 1 ? "" : "s"}\n`);
  },
});

const push = buildCommand({
  docs: {
    brief: "Push activity to the forge",
    fullDescription:
      "Push activity to the forge: push the change's branch, open its forge " +
      "change if there is none (merging into the change's parent), retarget " +
      "it to the parent, and post the change's comments the forge lacks.",
  },
  parameters: {
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to push (defaults to current)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: RefName }) {
    const backend = await this.backend();
    const forge = await this.forge();
    const change = flags.change ?? (await backend.currentBranch());
    const entries = await backend.readLog(change);
    assertChangeExists(change, entries);
    const pushed = await pushChange(backend, this.now, forge, change, entries);
    if (pushed.opened) {
      this.process.stdout.write(`opened ${forge.locator}#${pushed.id}\n`);
    }
    if (pushed.reviewers > 0) {
      this.process.stdout.write(
        `updated ${pushed.reviewers} reviewer${pushed.reviewers === 1 ? "" : "s"} on ${forge.locator}#${pushed.id}\n`,
      );
    }
    this.process.stdout.write(
      `pushed ${pushed.comments} comment${pushed.comments === 1 ? "" : "s"} to ${forge.locator}#${pushed.id}\n`,
    );
  },
});

const land = buildCommand({
  docs: {
    brief: "Land a change into its parent",
    fullDescription:
      "Land a change: write it onto its parent as a commit marked as landing " +
      "(a merge, or a squash with git config cabaret.landMethod squash), so " +
      "the parent's reviewers are not asked to re-review the change's diff, " +
      "and record the landing in the change's log. A change tracked on a " +
      "forge lands by merging there and fetching the result; git config " +
      "cabaret.landVia local (or forge) picks one side " +
      "unconditionally. The change must sit on its parent's tip; `cabaret " +
      "rebase` first if it does not. A landed change can no longer be " +
      "rebased, renamed, reparented, or transferred, though reviewing it is " +
      "still recorded. A range `ancestor..descendant` lands every change " +
      "after `ancestor` on `descendant`'s parent chain, `descendant` first, " +
      "skipping changes that already landed; when one fails, the landings " +
      "before it stand, and rerunning the range resumes.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change or ancestor..descendant range to land (defaults to current)",
          placeholder: "change",
          parse: parseChangeSpec,
          optional: true,
        },
      ],
    },
    flags: { evenThoughNotOwner, evenThoughUnreviewed },
  },
  async func(
    this: LocalContext,
    flags: { evenThoughNotOwner: boolean; evenThoughUnreviewed: boolean },
    spec?: ChangeSpec,
  ) {
    const backend = await this.backend();
    const config = await readConfig(backend);
    const landOne = async (change: RefName, entries: readonly LogEntry[]) => {
      const merged = await landAsConfigured(backend, this.now, this.forge, config, change, entries, {
        notOwner: flags.evenThoughNotOwner,
        unreviewed: flags.evenThoughUnreviewed,
      });
      if (merged !== undefined) {
        this.process.stdout.write(`merged ${merged.forge}#${merged.id}\n`);
      }
    };
    if (spec === undefined || spec.kind === "one") {
      const target = spec?.change ?? (await backend.currentBranch());
      await landOne(target, await backend.readLog(target));
    } else {
      const chain = await resolveRange(backend, spec.ancestor, spec.descendant);
      await landChain(backend, chain, landOne);
    }
  },
});

const conflicts = buildCommand({
  docs: {
    brief: "Show a change's unresolved conflict markers",
    fullDescription:
      "Show each conflict marker left in a change's files, as file:line: " +
      "text. A rebase that conflicts commits the markers in place; this " +
      "lists what remains to fix.",
  },
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
    const target = change ?? (await backend.currentBranch());
    const entries = await backend.readLog(target);
    const base = await changeBase(backend, target, entries);
    const tip = await changeTip(backend, target, entries);
    for (const file of await backend.changedFiles(base, tip)) {
      const content = await backend.readFile(tip, file);
      if (content === undefined) {
        continue;
      }
      for (const { line, text } of conflictMarkers(content)) {
        this.process.stdout.write(`${file}:${line}: ${text}\n`);
      }
    }
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

const setOwner = buildCommand({
  docs: {
    brief: "Set a change's owner",
    fullDescription:
      "Set a change's owner, replacing the current one. Only the owner may " +
      "transfer ownership; `show` displays the owner.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the new owner", placeholder: "user", parse: parseUser }],
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to transfer (defaults to current)",
        optional: true,
      },
      evenThoughNotOwner,
    },
  },
  async func(this: LocalContext, flags: { change?: RefName; evenThoughNotOwner: boolean }, newOwner: UserName) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    await transferChange(backend, this.now, change, newOwner, flags.evenThoughNotOwner);
  },
});

/** Render `audit`'s standing as a value with annotations, in `config list`'s idiom. */
function shownStanding({ rec, standing }: SetupAudit, declined: ReadonlySet<ConfigScope>): string {
  switch (standing.kind) {
    case "applied":
      return rec.value;
    case "unset":
      return `${rec.value} (unset${declined.has(rec.scope) ? ", declined" : ""})`;
    case "differs":
      return `${standing.current} (differs from ${rec.value})`;
  }
}

const setup = buildRouteMap({
  docs: {
    brief: "Check and apply recommended git configuration",
    fullDescription:
      "Git configuration Cabaret recommends: zdiff3 conflict markers, " +
      "rerere, and fetching change logs with every git fetch. `list` shows " +
      "each recommendation's status; `apply` sets the unset ones, leaving a " +
      "key already set to another value alone.",
  },
  routes: {
    list: buildCommand({
      docs: { brief: "Show each recommendation and its status" },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        const declined = await declinedScopes(backend);
        const audits = await auditSetup(backend);
        const width = Math.max(...audits.map(({ rec }) => rec.key.length));
        for (const audit of audits) {
          this.process.stdout.write(`${audit.rec.key.padEnd(width)}  ${shownStanding(audit, declined)}\n`);
        }
      },
    }),
    apply: buildCommand({
      docs: { brief: "Apply the recommendations not yet set" },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        const audits = await auditSetup(backend);
        await applySetup(backend, audits);
        let acted = false;
        for (const { rec, standing } of audits) {
          if (standing.kind === "unset") {
            this.process.stdout.write(`${rec.multi ? "added" : "set"} ${rec.key} = ${rec.value}\n`);
            acted = true;
          } else if (standing.kind === "differs") {
            this.process.stdout.write(`kept ${rec.key} = ${standing.current}\n`);
            acted = true;
          }
        }
        if (!acted) {
          this.process.stdout.write("nothing to apply\n");
        }
      },
    }),
  },
});

const rebase = buildCommand({
  docs: {
    brief: "Move a change onto its parent's tip",
    fullDescription:
      "Move a change onto its parent's tip by merging the tip into the " +
      "change, then record the new base in the log. A conflicting merge is " +
      "committed with its markers in place; fix them and amend, then " +
      "continue. Only the change's owner may rebase it. A range " +
      "`ancestor..descendant` rebases every change after `ancestor` on " +
      "`descendant`'s parent chain, ancestormost first, skipping changes " +
      "that have landed; a conflict stops the range there, and rerunning it " +
      "resumes once the conflict is fixed.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change or ancestor..descendant range to rebase (defaults to current)",
          placeholder: "change",
          parse: parseChangeSpec,
          optional: true,
        },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, spec?: ChangeSpec) {
    const backend = await this.backend();
    if (spec === undefined || spec.kind === "one") {
      const target = spec?.change ?? (await backend.currentBranch());
      await rebaseChange(backend, this.now, target, await backend.readLog(target), flags.evenThoughNotOwner);
      return;
    }
    const chain = await resolveRange(backend, spec.ancestor, spec.descendant);
    await rebaseChain(backend, this.now, chain, flags.evenThoughNotOwner);
  },
});

const rename = buildCommand({
  docs: {
    brief: "Rename a change",
    fullDescription:
      "Rename a change: move its branch and its log to the new name together, " +
      "atomically. Only the change's owner may rename it.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change's old name", placeholder: "old", parse: parseRefName },
        { brief: "change's new name", placeholder: "new", parse: parseRefName },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, from: RefName, to: RefName) {
    await renameChange(await this.backend(), from, to, flags.evenThoughNotOwner);
  },
});

const reparent = buildCommand({
  docs: {
    brief: "Update a change's parent",
    fullDescription:
      "Update a change's parent. This is a metadata/log change only, and does not " +
      "touch code without a subsequent `rebase`. Only the change's owner may " +
      "reparent it.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change to reparent", placeholder: "change", parse: parseRefName },
        { brief: "the new parent", placeholder: "parent", parse: parseRefName },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, change: RefName, parent: RefName) {
    await reparentChange(await this.backend(), this.now, change, parent, flags.evenThoughNotOwner);
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

/**
 * Render a TODO's content indented two spaces, dropping the comment's own
 * indentation (column plus two covers the opening marker) from continuation
 * lines. Lines that don't carry that indentation — line-comment
 * continuations keep their marker, for one — are indented as they are.
 */
function reindentTodo(todo: Todo): string {
  const indent = " ".repeat(todo.col + 2);
  const lines = todo.content.split("\n").map((line, i) => {
    if (line.startsWith(indent)) {
      return `  ${line.slice(indent.length)}`;
    }
    return indent.startsWith(line) ? "" : i === 0 ? `  ${line}` : undefined;
  });
  return lines.includes(undefined)
    ? todo.content
        .split("\n")
        .map((line) => (line === "" ? "" : `  ${line}`))
        .join("\n")
    : lines.join("\n");
}

const todos = buildCommand({
  docs: {
    brief: "Show the TODOs a change adds",
    fullDescription:
      "Show the TODOs a change adds: the TODO comments in the tip's copy of " +
      "each changed file with no matching TODO in the base's copy. Matching " +
      "ignores position and whitespace, so a pre-existing TODO that merely " +
      "moves does not appear.",
  },
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
    const target = change ?? (await backend.currentBranch());
    const base = await changeBase(backend, target, await backend.readLog(target));
    // Pin to the branch namespace so a same-named tag cannot shadow the
    // change's tip.
    const tip = await backend.resolveCommit(`refs/heads/${target}`);
    const rendered: string[] = [];
    for (const file of await backend.changedFiles(base, tip)) {
      const [prev, next] = await Promise.all([backend.readFile(base, file), backend.readFile(tip, file)]);
      for (const todo of newTodos(prev, next)) {
        rendered.push(`${file}:${todo.line}:${todo.col}:\n${reindentTodo(todo)}\n`);
      }
    }
    this.process.stdout.write(rendered.join("\n"));
  },
});

const show = buildCommand({
  docs: { brief: "Show a change's status" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to show (defaults to current)",
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
    const page = await showPage(backend, await backend.currentUser(), target);
    writeDoc(this, showDoc(page));
  },
});

/** Print a rendered page: its text to stdout, its errors to stderr. */
function writeDoc(context: LocalContext, doc: Doc): void {
  context.process.stdout.write(`${docText(doc)}\n`);
  for (const error of doc.errors) {
    context.process.stderr.write(`${error}\n`);
  }
}

const sync = buildCommand({
  docs: {
    brief: "Sync review state with origin",
    fullDescription:
      "Sync review state with origin: fetch every change's log, merge it " +
      "with the local log, and push the result. Only logs move; branches " +
      "sync through git or `cabaret pull`/`cabaret push`.",
  },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    const backend = await this.backend();
    const changes = await backend.syncLogs();
    this.process.stdout.write(`synced ${changes.length} change${changes.length === 1 ? "" : "s"} with origin\n`);
  },
});

const todo = buildCommand({
  docs: { brief: "Show the changes awaiting your attention" },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    const backend = await this.backend();
    const page = await todoPage(backend, await currentSelf(backend));
    writeDoc(this, todoDoc(page));
  },
});

const routes = buildRouteMap({
  docs: {
    brief: "Diff-based distributed code review built on top of git",
  },
  routes: {
    approve,
    comment,
    config,
    conflicts,
    create,
    dev,
    diff,
    forget,
    land,
    log,
    pull,
    push,
    rebase,
    rename,
    reparent,
    review,
    reviewers,
    "set-owner": setOwner,
    setup,
    show,
    sync,
    todo,
    todos,
  },
});

export const app = buildApplication(routes, {
  name: "cabaret",
  versionInfo: { currentVersion: VERSION },
  // Display flags as kebab-case (matching the CLI-wide convention) while still
  // accepting the camelCase spelling of each flag name.
  scanner: { caseStyle: "allow-kebab-for-camel" },
  localization: {
    text: {
      ...text_en,
      // A `UserError`'s message is the complete diagnostic, so it prints
      // bare. Any other exception is a bug in Cabaret, where the default
      // stack-bearing rendering earns its keep.
      formatException: (exc) =>
        exc instanceof UserError ? userMessage(exc) : exc instanceof Error ? (exc.stack ?? String(exc)) : String(exc),
      exceptionWhileRunningCommand(exc, ansiColor) {
        return exc instanceof UserError
          ? userMessage(exc)
          : text_en.exceptionWhileRunningCommand.call(this, exc, ansiColor);
      },
    },
  },
});
