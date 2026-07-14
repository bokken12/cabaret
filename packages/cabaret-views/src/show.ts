import {
  type Backend,
  type ChangeComment,
  type ChangeSummary,
  type CommitHash,
  currentComments,
  type FilePath,
  isSatisfied,
  obligationStatuses,
  type RefName,
  reviewerSummary,
  summarizeChange,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, type Span, span, type Target } from "./doc.js";
import { table } from "./table.js";

/** What the show page displays. */
export interface ShowPage {
  readonly summary: ChangeSummary;
  readonly comments: readonly ChangeComment[];
  /** Per-reviewer tallies of unsatisfied obligations; empty once landed. */
  readonly remaining: readonly string[];
}

/** Query the show page for `change`. */
export async function showPage(backend: Backend, user: UserName, change: RefName): Promise<ShowPage> {
  const entries = await backend.readLog(change);
  const summary = await summarizeChange(backend, change, entries, user);
  // A landed change has no review to demand, whatever state it landed in.
  const remaining =
    summary.landed === undefined
      ? reviewerSummary(
          (await obligationStatuses(backend, entries, summary.owner, summary.base, summary.tip)).filter(
            (status) => !isSatisfied(status),
          ),
        )
      : [];
  return { summary, comments: await currentComments(entries), remaining };
}

/** Hashes display abbreviated; full hashes travel in targets, never prose. */
function shortHash(hash: CommitHash): string {
  return hash.slice(0, 12);
}

/** `value (note)`, or just `value` without a note. */
function noted(value: string, note: string | undefined): string {
  return note === undefined ? value : `${value} (${note})`;
}

const ORIGIN_NOTES: Record<NonNullable<ChangeSummary["origin"]>, string> = {
  ahead: "ahead of origin",
  behind: "behind origin",
  diverged: "diverged from origin",
};

const PARENT_NOTES: Record<NonNullable<ChangeSummary["deadParent"]>, string> = {
  landed: "landed",
  missing: "does not exist",
};

const BASE_NOTES: Record<NonNullable<ChangeSummary["staleBase"]>, string> = {
  behind: "behind parent",
  diverged: "diverged from parent",
};

/** The heading, its rule, and the attribute table every show page opens with. */
function header(heading: Span, attributes: readonly (readonly [string, string])[]): Line[] {
  return [
    { spans: [heading] },
    { spans: [span("=".repeat(heading.text.length))] },
    { spans: [] },
    ...table(
      [
        { header: "attribute", align: "left" },
        { header: "value", align: "left" },
      ],
      attributes.map(([attribute, value]) => [span(attribute), span(value)]),
    ),
  ];
}

/** The files section, each row resolving to `target(file)` when one is given. */
function filesToReview(files: readonly FilePath[], target?: (file: FilePath) => Target): Line[] {
  if (files.length === 0) {
    return [];
  }
  return [
    { spans: [] },
    { spans: [span("Files to review:", { style: "heading" })] },
    ...files.map((file) => ({
      spans: [span("  "), span(file, target === undefined ? {} : { target: target(file) })],
    })),
  ];
}

/** The remaining review section: one tally row per reviewer with files left. */
function remainingReview(remaining: readonly string[]): Line[] {
  if (remaining.length === 0) {
    return [];
  }
  return [
    { spans: [] },
    { spans: [span("Remaining review:", { style: "heading" })] },
    ...remaining.map((row) => ({ spans: [span(`  ${row}`)] })),
  ];
}

/** The comments section: each comment's time and author, then its indented text. */
function commentsSection(comments: readonly ChangeComment[]): Line[] {
  if (comments.length === 0) {
    return [];
  }
  const lines: Line[] = [{ spans: [] }, { spans: [span("Comments:", { style: "heading" })] }];
  comments.forEach(({ timestamp, user, text }, index) => {
    // A blank line between comments, since consecutive comments would
    // otherwise run together.
    if (index > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span(`  ${new Date(timestamp).toISOString()} ${user}`)] });
    for (const line of text.split("\n")) {
      lines.push({ spans: line === "" ? [] : [span(`    ${line}`)] });
    }
  });
  return lines;
}

export function showDoc(page: ShowPage): Doc {
  const summary = page.summary;
  // Each row notes how its own reading disagrees with what it should track.
  const attributes: [string, string][] = [
    ["next step", summary.nextStep],
    ["owner", summary.owner],
  ];
  if (summary.reviewers.length > 0) {
    attributes.push(["reviewers", summary.reviewers.join(", ")]);
  }
  attributes.push(["parent", noted(summary.parent, summary.deadParent && PARENT_NOTES[summary.deadParent])]);
  if (summary.forgeChange !== undefined) {
    attributes.push(["forge change", `${summary.forgeChange.forge}#${summary.forgeChange.id}`]);
  }
  if (summary.landed !== undefined) {
    attributes.push(["landed", shortHash(summary.landed)]);
  }
  attributes.push(
    ["tip", noted(shortHash(summary.tip), summary.origin && ORIGIN_NOTES[summary.origin])],
    ["base", noted(shortHash(summary.base), summary.staleBase && BASE_NOTES[summary.staleBase])],
  );
  // No target: the heading names the page itself.
  const heading = span(summary.change, { style: "heading" });
  return {
    lines: [
      ...header(heading, attributes),
      ...remainingReview(page.remaining),
      ...commentsSection(page.comments),
      ...filesToReview(summary.reviewLeft, (file) => ({ kind: "file", change: summary.change, file })),
    ],
  };
}
