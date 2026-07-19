import {
  type Backend,
  type ChangeComment,
  type ChangeName,
  type ChangeSummary,
  changeDiff,
  currentComments,
  type FilePath,
  forgeChangeUrl,
  isSatisfied,
  type LandMerge,
  obligationStatuses,
  type ReviewerTally,
  reviewerTallies,
  selfAs,
  shortHash,
  summarizeChange,
  summarizeTrunk,
  type TimestampMs,
  type TrunkSummary,
  tallyText,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, layout, type Node, type Section, type Span, section, span, type Target } from "./doc.js";
import { fetchedFooter } from "./fetched.js";
import { stepSpan } from "./steps.js";
import { type Cell, table } from "./table.js";
import { type WorkspaceNote, workspaceNotes } from "./workspaces.js";

/** What the show page displays. */
export interface ShowPage {
  /** The change's status — read from its log, or from its history alone when it has none. */
  readonly summary: ChangeSummary | TrunkSummary;
  /** Whose reading this is when not the current user's own, as `selfAs` resolves it. */
  readonly as: UserName | undefined;
  readonly comments: readonly ChangeComment[];
  /** Per-reviewer tallies of unsatisfied obligations; empty once landed. */
  readonly remaining: readonly ReviewerTally[];
  /** The change's workspace on this device, when it has one. */
  readonly workspace: WorkspaceNote | undefined;
  /** When this clone last fetched from origin, when known. */
  readonly fetched: TimestampMs | undefined;
}

/** Query the show page for `change`, read as the current user or as `as`. */
export async function showPage(backend: Backend, change: ChangeName, as?: UserName): Promise<ShowPage> {
  const entries = await backend.readLog(change);
  const acting = await selfAs(backend, as);
  const fetched = await backend.originFetched();
  if (entries.length === 0) {
    // A branch with no log still names a line of history worth viewing; its
    // log-borne sections are simply empty.
    return {
      summary: await summarizeTrunk(backend, change),
      as: acting.as,
      comments: [],
      remaining: [],
      workspace: (await workspaceNotes(backend)).get(change),
      fetched,
    };
  }
  const diff = await changeDiff(backend, change, entries);
  const summary = await summarizeChange(backend, change, entries, acting.self.user, diff);
  // A landed change has no review to demand, whatever state it landed in;
  // an archived one asks nothing while set aside.
  const remaining =
    summary.landed === undefined && !summary.archived
      ? reviewerTallies(
          (await obligationStatuses(backend, entries, summary.owner, diff)).filter((status) => !isSatisfied(status)),
        )
      : [];
  return {
    summary,
    as: acting.as,
    comments: await currentComments(entries),
    remaining,
    workspace: (await workspaceNotes(backend)).get(change),
    fetched,
  };
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
function header(heading: Span, attributes: readonly (readonly [string, string | Cell])[]): Line[] {
  return [
    { spans: [heading] },
    { spans: [span("=".repeat(heading.text.length))] },
    { spans: [] },
    ...table(
      [
        { header: "attribute", align: "left" },
        { header: "value", align: "left" },
      ],
      attributes.map(([attribute, value]) => [span(attribute), typeof value === "string" ? span(value) : value]),
    ),
  ];
}

/** The files section, each row resolving to `target(file)` when one is given. */
function filesToReview(files: readonly FilePath[], target?: (file: FilePath) => Target): Section | undefined {
  if (files.length === 0) {
    return undefined;
  }
  return section(
    { spans: [span("Files to review:", { style: "heading" })] },
    files.map((file) => ({
      spans: [span("  "), span(file, target === undefined ? {} : { target: target(file) })],
    })),
  );
}

/**
 * The included changes section: one row per change landed into this one,
 * newest first — the recent lands are the ones worth a look — linking to its
 * page. `truncated` closes the section with an ellipsis: the history holds
 * more than the bounded survey read.
 */
function includedChanges(
  included: readonly LandMerge[],
  as: UserName | undefined,
  truncated: boolean,
): Section | undefined {
  if (included.length === 0 && !truncated) {
    return undefined;
  }
  return section({ spans: [span("Included changes:", { style: "heading" })] }, [
    ...[...included].reverse().map(({ change }) => ({
      spans: [span("  "), span(change, { target: { kind: "change", change, as } })],
    })),
    ...(truncated ? [{ spans: [span("  …", { style: "context" })] }] : []),
  ]);
}

/** The remaining review section: one tally row per reviewer with files left, opening their review. */
function remainingReview(change: ChangeName, remaining: readonly ReviewerTally[]): Section | undefined {
  if (remaining.length === 0) {
    return undefined;
  }
  return section(
    { spans: [span("Remaining review:", { style: "heading" })] },
    remaining.map((tally) => ({
      spans: [span("  "), span(tallyText(tally), { target: { kind: "review", change, as: tally.user } })],
    })),
  );
}

/** The comments section: each comment's time and author, then its indented text. */
function commentsSection(comments: readonly ChangeComment[]): Section | undefined {
  if (comments.length === 0) {
    return undefined;
  }
  const body: Line[] = [];
  comments.forEach(({ timestamp, user, text }, index) => {
    // A blank line between comments, since consecutive comments would
    // otherwise run together.
    if (index > 0) {
      body.push({ spans: [] });
    }
    body.push({ spans: [span(`  ${new Date(timestamp).toISOString()} ${user}`)] });
    for (const line of text.split("\n")) {
      body.push({ spans: line === "" ? [] : [span(`    ${line}`)] });
    }
  });
  return section({ spans: [span("Comments:", { style: "heading" })] }, body);
}

export function showDoc(page: ShowPage): Doc {
  const summary = page.summary;
  // Each row notes how its own reading disagrees with what it should track.
  // A trunk's log never declared anything, so only its history's rows appear.
  const attributes: [string, string | Cell][] = [];
  if (summary.kind === "change") {
    attributes.push(["next step", stepSpan(summary.nextStep, summary.change, page.as)], ["owner", summary.owner]);
    if (summary.reviewers.length > 0) {
      attributes.push(["reviewers", summary.reviewers.join(", ")]);
    }
    if (summary.landed === undefined) {
      attributes.push(["reviewing", summary.reviewing]);
    }
    attributes.push([
      "parent",
      noted(
        summary.parent,
        summary.deadParent !== undefined
          ? PARENT_NOTES[summary.deadParent]
          : summary.parentOrigin && ORIGIN_NOTES[summary.parentOrigin],
      ),
    ]);
    if (summary.forgeChange !== undefined) {
      const { forge, id, staleParent } = summary.forgeChange;
      const url = forgeChangeUrl(forge, id);
      attributes.push([
        "forge change",
        [
          span(`${forge}#${id}`, url === undefined ? {} : { target: { kind: "url", url } }),
          ...(staleParent === undefined ? [] : [span(` (merges into ${staleParent})`)]),
        ],
      ]);
    }
    if (summary.landed !== undefined) {
      attributes.push(["landed", shortHash(summary.landed)]);
    }
  }
  attributes.push(["tip", noted(shortHash(summary.tip), summary.origin && ORIGIN_NOTES[summary.origin])]);
  if (summary.kind === "change") {
    attributes.push(["base", noted(shortHash(summary.base), summary.staleBase && BASE_NOTES[summary.staleBase])]);
  }
  if (page.workspace !== undefined) {
    attributes.push(["workspace", noted(page.workspace.display, page.workspace.dirty ? "dirty" : undefined)]);
  }
  // No target: the heading names the page itself.
  const heading = span(page.as === undefined ? summary.change : `${summary.change} as ${page.as}`, {
    style: "heading",
  });
  const nodes: Node[] = header(heading, attributes);
  // Each section stands off from what precedes it with a blank line.
  for (const s of [
    includedChanges(summary.included, page.as, summary.kind === "trunk" && summary.truncated),
    remainingReview(summary.change, page.remaining),
    commentsSection(page.comments),
    summary.kind === "change"
      ? filesToReview(summary.reviewLeft, (file) => ({ kind: "file", change: summary.change, file, as: page.as }))
      : undefined,
  ]) {
    if (s !== undefined) {
      nodes.push({ spans: [] }, s);
    }
  }
  nodes.push(...fetchedFooter(page.fetched));
  return layout(nodes);
}
