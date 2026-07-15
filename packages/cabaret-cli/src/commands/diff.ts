import { buildCommand } from "@stricli/core";
import {
  brain,
  changeBase,
  defaultContext,
  type FilePath,
  parseContext,
  parseFilePath,
  parseRefName,
  type RefName,
  type ReviewSpan,
  readConfig,
  rebasedView,
  remainingSpans,
  renderDiff,
  renderDiff4,
  reviewSpans,
  UserError,
  type UserName,
} from "cabaret-core";
import type { LocalContext } from "../context.js";
import { parseUser } from "./shared.js";

export const diff = buildCommand({
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
