import {
  type Backend,
  type ChangeComment,
  type ChangeSummary,
  type CommitHash,
  currentComments,
  type FilePath,
  type ForgeChange,
  type ForgeLocator,
  type ForgeSnapshot,
  isSatisfied,
  obligationStatuses,
  type RefName,
  reviewerSummary,
  summarizeChange,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, type Span, span, type Target } from "./doc.js";
import { table } from "./table.js";

/**
 * What the show page displays: a change, or an open forge change with no
 * change log yet, shown as the change importing it would create.
 */
export type ShowPage =
  | {
      readonly kind: "change";
      readonly summary: ChangeSummary;
      readonly comments: readonly ChangeComment[];
      /** Per-reviewer tallies of unsatisfied obligations; empty once landed. */
      readonly remaining: readonly string[];
    }
  | {
      readonly kind: "forge-change";
      readonly forge: ForgeLocator;
      readonly change: ForgeChange;
      readonly files: readonly FilePath[];
      readonly comments: readonly ChangeComment[];
    };

/**
 * Query the show page for `change`. A name with no log yet falls back to its
 * open forge change in the snapshot, so an unimported forge change previews
 * as the change importing it would create.
 */
export async function showPage(
  backend: Backend,
  user: UserName,
  change: RefName,
  snapshot?: ForgeSnapshot,
): Promise<ShowPage> {
  const entries = await backend.readLog(change);
  if (entries.length === 0 && snapshot !== undefined) {
    // Forge changes sharing a head collapse to the oldest, as on the todo page.
    const found = [...snapshot.changes]
      .sort((a, b) => a.change.id - b.change.id)
      .find((candidate) => candidate.change.head === change);
    if (found !== undefined) {
      const comments = found.comments.map(({ updatedAt, author, body }) => ({
        timestamp: updatedAt,
        user: author,
        text: body,
      }));
      return { kind: "forge-change", forge: snapshot.locator, change: found.change, files: found.files, comments };
    }
  }
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
  return { kind: "change", summary, comments: await currentComments(entries), remaining };
}

/** Hashes display abbreviated; full hashes travel in targets, never prose. */
function shortHash(hash: CommitHash): string {
  return hash.slice(0, 12);
}

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
  if (page.kind === "forge-change") {
    const { forge, change, files } = page;
    // The heading resolves to the forge change so hosts can find what to
    // import from anywhere on the page, but on the jump tier: as a link it
    // would only lead back here.
    const heading = span(change.head, {
      style: "heading",
      target: { kind: "forge-change", id: change.id, change: change.head },
      tier: "jump",
    });
    return {
      lines: [
        ...header(heading, [
          ["next step", "import"],
          ["owner", change.author],
          ["parent", change.parent],
          ["forge change", `${forge}#${change.id}`],
          ["title", change.title],
        ]),
        ...commentsSection(page.comments),
        // No file targets: the files have no diffs to open until the import.
        ...filesToReview(files),
      ],
    };
  }
  const summary = page.summary;
  const attributes: [string, string][] = [
    ["next step", summary.nextStep],
    ["owner", summary.owner],
    ["parent", summary.parent],
  ];
  if (summary.forgeChange !== undefined) {
    attributes.push(["forge change", `${summary.forgeChange.forge}#${summary.forgeChange.id}`]);
  }
  if (summary.landed !== undefined) {
    attributes.push(["landed", shortHash(summary.landed)]);
  }
  attributes.push(["tip", shortHash(summary.tip)], ["base", shortHash(summary.base)]);
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
