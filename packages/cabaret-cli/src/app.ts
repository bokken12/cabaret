import { buildApplication, buildCommand, buildRouteMap, text_en } from "@stricli/core";
import {
  assertChangeExists,
  type Backend,
  brain,
  changeBase,
  createChange,
  currentForgeChange,
  currentParent,
  type DiffSegment,
  type FilePath,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  forgeChangeId,
  formatLogEntry,
  importChange,
  type LogEntry,
  landAsConfigured,
  landChain,
  landedMerge,
  NotOwnerError,
  newTodos,
  observedLand,
  parseContext,
  parseFilePath,
  parseRefName,
  planPull,
  planPush,
  type RefName,
  readConfig,
  rebaseChain,
  rebaseChange,
  renameChange,
  reparentChange,
  resolveRange,
  reviewSegments,
  syncedForgeChange,
  syncForgeSnapshot,
  type Todo,
  transferChange,
  UnsatisfiedObligationsError,
  UserError,
  type UserName,
  userName,
  VERSION,
} from "cabaret-core";
import { defaultContext, docText, renderDiff, renderDiff4, showDoc, showPage, todoDoc, todoPage } from "cabaret-views";
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
          "Delete the review state this repository holds: every change's log, " +
          "the fetched copies of origin's logs, and the forge snapshot. " +
          "Branches and commits stay, and origin keeps its logs, so `cabaret " +
          "sync` restores them. --remote deletes origin's logs too, for every " +
          "user of the repository.",
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
        this.process.stdout.write(
          `wiped the logs of ${wiped.length} change${wiped.length === 1 ? "" : "s"} and the forge snapshot\n`,
        );
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
      const [prevBase, nextBase, prevTip, nextTip] = await Promise.all([
        backend.readFile(reviewed.base, file),
        backend.readFile(base, file),
        backend.readFile(reviewed.tip, file),
        backend.readFile(tip, file),
      ]);
      // A moved base still leaves the 2-way diff from the reviewed tip sound
      // in two cases: the base's copy of the file is unchanged (the reviewed
      // diff's start is intact), or the new base's copy equals the reviewed
      // tip's (the whole new diff starts at contents the reviewer knows).
      // Otherwise the base's copy changed underneath the review, which takes
      // a 4-way diff.
      if (prevBase === nextBase || nextBase === prevTip) {
        this.process.stdout.write(renderDiff(file, prevTip, nextTip, color, context));
      } else {
        const rendered = renderDiff4({
          file,
          revs: { b1: reviewed.base, b2: base, f1: reviewed.tip, f2: tip },
          contents: { b1: prevBase, b2: nextBase, f1: prevTip, f2: nextTip },
          color,
          context,
        });
        this.process.stdout.write(rendered.length === 0 ? "" : `${rendered.map((line) => line.text).join("\n")}\n`);
      }
      return;
    }
    let segments: readonly DiffSegment[];
    if (reviewed !== undefined && !(await backend.isAncestor(reviewed.tip, tip))) {
      // The tip was rewritten out from under the review, so the reviewed tip
      // cannot be placed among the first-parent segments; diffing from its
      // contents still shows exactly what the reviewer has not seen.
      segments = [{ start: reviewed.tip, end: tip }];
    } else {
      segments = await reviewSegments(backend, base, tip, reviewed?.tip);
    }
    // Base and tip join the existence check even when review or a land merge
    // drops them from the segments: a file present anywhere in the change is
    // simply done (empty output), while a name found nowhere is an error.
    const revs = [...new Set([...segments.flatMap(({ start, end }) => [start, end]), base, tip])];
    const contents = new Map(
      await Promise.all(revs.map(async (rev) => [rev, await backend.readFile(rev, file)] as const)),
    );
    if (revs.every((rev) => contents.get(rev) === undefined)) {
      throw new UserError(`${file} exists at none of ${revs.join(", ")}`);
    }
    const rendered = segments
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

/** Parse a PR-number argument. */
function parseChangeNumber(raw: string): ForgeChangeId {
  return forgeChangeId(Number(raw));
}

/**
 * Pull one change's forge activity into its log: comments the log lacks —
 * new ones, and new versions of ones edited in place — and the land a merged
 * forge change implies. Reports what it appended on `stdout`.
 */
async function pullChange(
  context: LocalContext,
  backend: Backend,
  forge: Forge,
  change: RefName,
  entries: readonly LogEntry[],
  forgeChange: ForgeChange,
): Promise<void> {
  const additions = [...(await planPull(forge.locator, entries, await forge.listComments(forgeChange.id)))];
  const landing = observedLand(context.now, await backend.currentUser(), forgeChange, entries);
  if (landing !== undefined) {
    additions.push(landing);
  }
  await backend.appendLog(change, additions);
  if (landing !== undefined) {
    context.process.stdout.write(`${forge.locator}#${forgeChange.id} was merged; recorded the land\n`);
  }
  const pulled = additions.filter(({ action }) => action.kind === "comment").length;
  context.process.stdout.write(
    `pulled ${pulled} comment${pulled === 1 ? "" : "s"} from ${forge.locator}#${forgeChange.id}\n`,
  );
}

const gh = buildRouteMap({
  docs: { brief: "GitHub integration" },
  routes: {
    import: buildCommand({
      docs: {
        brief: "Import a PR as a change",
        fullDescription:
          "Import a PR as a change to review: fetch its head branch, create " +
          "the change owned by the PR's author with the PR's base branch as " +
          "its parent, and pull the PR's comments.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "PR number to import", placeholder: "number", parse: parseChangeNumber }],
        },
      },
      async func(this: LocalContext, _flags: Record<never, never>, id: ForgeChangeId) {
        const backend = await this.backend();
        const forge = await this.forge();
        const result = await importChange(backend, this.now, forge, id);
        await syncForgeSnapshot(backend, this.now, forge);
        if (result.kind === "exists") {
          throw new UserError(
            `change already exists: ${JSON.stringify(result.change)}; run \`cabaret gh pull\` to sync it`,
          );
        }
        this.process.stdout.write(
          `imported ${forge.locator}#${id} as ${JSON.stringify(result.change)} with ` +
            `${result.comments} comment${result.comments === 1 ? "" : "s"}\n`,
        );
      },
    }),
    pull: buildCommand({
      docs: {
        brief: "Pull PR activity from GitHub",
        fullDescription:
          "Pull PR activity from GitHub: refresh the mirror of open PRs that " +
          "the todo and show pages render from, import PR comments — new " +
          "ones, and new versions of ones edited in place — into change " +
          "logs, and record merged PRs as landing their changes. Pulls every " +
          "unlanded change with a PR; --change restricts it to one.",
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
        const snapshot = await syncForgeSnapshot(backend, this.now, forge);
        if (flags.change !== undefined) {
          const change = flags.change;
          await backend.syncLog(change);
          const entries = await backend.readLog(change);
          assertChangeExists(change, entries);
          const forgeChange = await syncedForgeChange(backend, this.now, forge, change, entries);
          if (forgeChange === undefined) {
            throw new UserError(
              `no PR for ${JSON.stringify(change)} on ${forge.locator}; run \`cabaret gh push\` first`,
            );
          }
          await pullChange(this, backend, forge, change, entries, forgeChange);
          return;
        }
        // The open PRs by head branch: what an untracked change can
        // adopt without asking the forge change by change.
        const open = new Map(snapshot.changes.map(({ change }) => [change.head, change]));
        for (const change of await backend.syncLogs()) {
          const entries = await backend.readLog(change);
          if (landedMerge(entries) !== undefined) {
            continue;
          }
          const recorded = currentForgeChange(entries);
          let forgeChange: ForgeChange | undefined;
          if (recorded !== undefined) {
            if (recorded.forge !== forge.locator) {
              continue;
            }
            // Fetched live: a PR merged or closed since the snapshot
            // still lands its change on this pull.
            forgeChange = await forge.getChange(recorded.id);
          } else {
            forgeChange = open.get(change);
            if (forgeChange === undefined) {
              continue;
            }
            await backend.appendLog(change, [
              {
                timestamp: this.now(),
                user: await backend.currentUser(),
                action: { kind: "set-forge", forge: forge.locator, id: forgeChange.id },
              },
            ]);
          }
          await pullChange(this, backend, forge, change, entries, forgeChange);
        }
        const count = snapshot.changes.length;
        this.process.stdout.write(`synced ${forge.locator}: ${count} open PR${count === 1 ? "" : "s"}\n`);
      },
    }),
    push: buildCommand({
      docs: {
        brief: "Push PR activity to GitHub",
        fullDescription:
          "Push PR activity to GitHub: push the change's branch, open its PR " +
          "if there is none (based on the change's parent), retarget the PR's " +
          "base to the parent, and post the change's comments the PR lacks.",
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
        const parent = currentParent(change, entries);
        await backend.pushBranch(change);
        let forgeChange = await syncedForgeChange(backend, this.now, forge, change, entries);
        if (forgeChange === undefined) {
          forgeChange = await forge.createChange(change, parent, change);
          await backend.appendLog(change, [
            {
              timestamp: this.now(),
              user: await backend.currentUser(),
              action: { kind: "set-forge", forge: forge.locator, id: forgeChange.id },
            },
          ]);
          this.process.stdout.write(`opened ${forge.locator}#${forgeChange.id}\n`);
        } else if (forgeChange.state === "open" && forgeChange.parent !== parent) {
          await forge.setParent(forgeChange.id, parent);
        }
        const bodies = await planPush(entries, await forge.listComments(forgeChange.id), await backend.currentUser());
        for (const body of bodies) {
          await forge.addComment(forgeChange.id, body);
        }
        await backend.syncLog(change);
        await syncForgeSnapshot(backend, this.now, forge);
        this.process.stdout.write(
          `pushed ${bodies.length} comment${bodies.length === 1 ? "" : "s"} to ${forge.locator}#${forgeChange.id}\n`,
        );
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
    let anyMerged = false;
    const landOne = async (change: RefName, entries: readonly LogEntry[]) => {
      const merged = await landAsConfigured(backend, this.now, this.forge, config, change, entries, {
        notOwner: flags.evenThoughNotOwner,
        unreviewed: flags.evenThoughUnreviewed,
      });
      if (merged !== undefined) {
        anyMerged = true;
        this.process.stdout.write(`merged ${merged.forge}#${merged.id}\n`);
      }
    };
    try {
      if (spec === undefined || spec.kind === "one") {
        const target = spec?.change ?? (await backend.currentBranch());
        await landOne(target, await backend.readLog(target));
      } else {
        const chain = await resolveRange(backend, spec.ancestor, spec.descendant);
        await landChain(backend, chain, landOne);
      }
    } finally {
      // Whatever merged is no longer open; the mirror must not keep showing
      // it. The land itself already stands, so a failed refresh only warns.
      if (anyMerged) {
        try {
          await syncForgeSnapshot(backend, this.now, await this.forge());
        } catch (error) {
          this.process.stderr.write(`warning: forge snapshot not refreshed: ${(error as Error).message}\n`);
        }
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

const rebase = buildCommand({
  docs: {
    brief: "Rebase a change onto its parent's tip",
    fullDescription:
      "Rebase a change onto its parent's tip, then record the new base in the " +
      "log. Replays only the commits after the change's base (`git rebase " +
      "--onto`), so commits the change shares with an old version of the parent " +
      "are never reapplied. Only the change's owner may rebase it. A range " +
      "`ancestor..descendant` rebases every change after `ancestor` on " +
      "`descendant`'s parent chain, ancestormost first, skipping changes that " +
      "have landed; when one fails, the rebases before it stand, and rerunning " +
      "the range resumes.",
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
    const page = await showPage(backend, await backend.currentUser(), target, await backend.readForgeSnapshot());
    this.process.stdout.write(`${docText(showDoc(page))}\n`);
  },
});

const sync = buildCommand({
  docs: {
    brief: "Sync review state with origin",
    fullDescription:
      "Sync review state with origin: fetch every change's log, merge it " +
      "with the local log, and push the result. Only logs move; branches " +
      "sync through git or `cabaret gh`.",
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
    const page = await todoPage(backend, await backend.currentUser(), await backend.readForgeSnapshot());
    this.process.stdout.write(`${docText(todoDoc(page))}\n`);
  },
});

const routes = buildRouteMap({
  docs: {
    brief: "Diff-based distributed code review built on top of git",
  },
  routes: {
    approve,
    approvers,
    comment,
    create,
    dev,
    diff,
    forget,
    gh,
    glab,
    land,
    log,
    rebase,
    rename,
    reparent,
    review,
    "set-owner": setOwner,
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
