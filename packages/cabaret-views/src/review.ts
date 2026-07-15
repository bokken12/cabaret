import {
  type Backend,
  type CommitHash,
  changeDiff,
  type DiffView,
  defaultContext,
  type FilePath,
  type FileView,
  type RefName,
  type ReviewRound,
  rebasedView,
  renderDiff4,
  reviewRounds,
  shortHash,
  type TimestampMs,
  type UserName,
} from "cabaret-core";
// The kernel entry, not `patdiff`, whose Node-flavored PatdiffCore reads the
// filesystem and console — imports a browser host cannot load.
import { IsBinary, PatdiffCore } from "patdiff/kernel";
import { type Doc, type Line, layout, type Span, type Style, span, type Target, type TargetTier } from "./doc.js";

/** The trailing note that `later` more rounds follow, or "" for the last round. */
function moreRounds(later: number): string {
  return later === 0 ? "" : `; ${later} more round${later === 1 ? "" : "s"} follow${later === 1 ? "s" : ""}`;
}

/**
 * One reading of a change's review state: everything the review and diff
 * pages derive their content from, queried once. Pages rendered from one
 * snapshot agree with each other, and a mark records exactly the round its
 * snapshot displayed — a commit racing the keypress cannot widen the marked
 * diff. A host chooses how long to keep one: fresh per render, or held for a
 * whole file-by-file review pass, where going stale only means not seeing
 * review state that changed elsewhere until the next refresh.
 */
export interface ChangeSnapshot {
  readonly change: RefName;
  /** Whose review state this is: the backend's current user. */
  readonly user: UserName;
  readonly base: CommitHash;
  readonly tip: CommitHash;
  readonly rounds: readonly ReviewRound[];
}

export async function changeSnapshot(backend: Backend, change: RefName): Promise<ChangeSnapshot> {
  const entries = await backend.readLog(change);
  const [diff, user] = await Promise.all([changeDiff(backend, change, entries), backend.currentUser()]);
  return {
    change,
    user,
    base: diff.base,
    tip: diff.tip,
    rounds: await reviewRounds(backend, entries, user, diff),
  };
}

/** A change's current round of review: what to read before any newer round opens. */
export interface ReviewPage {
  readonly change: RefName;
  /** Undefined when nothing is left to review. */
  readonly round:
    | {
        readonly end: CommitHash;
        readonly files: readonly FilePath[];
        /** Rounds still to come after this one. */
        readonly later: number;
      }
    | undefined;
}

export function reviewPage(snapshot: ChangeSnapshot): ReviewPage {
  const first = snapshot.rounds[0];
  return {
    change: snapshot.change,
    round: first && { end: first.end, files: [...first.files.keys()], later: snapshot.rounds.length - 1 },
  };
}

export function reviewDoc(page: ReviewPage): Doc {
  const title = `Review ${page.change}`;
  // The page's whole target is proceeding with review: every line resolves
  // to the round's first file, on the jump tier so only the file names read
  // as links, and a file's own line resolves to that file instead. The title
  // offers no way back to the change — here, going deeper means reviewing.
  const first = page.round?.files[0];
  const proceed: { target: Target; tier: TargetTier } | undefined =
    first === undefined ? undefined : { target: { kind: "file", change: page.change, file: first }, tier: "jump" };
  const lines: Line[] = [
    { spans: [span(title, { style: "heading", ...proceed })] },
    { spans: [span("=".repeat(title.length), proceed)] },
    { spans: [span("", proceed)] },
  ];
  if (page.round === undefined) {
    lines.push({ spans: [span("Nothing left to review.")] });
    return layout(lines);
  }
  lines.push(
    { spans: [span(`Reviewing up to ${shortHash(page.round.end)}${moreRounds(page.round.later)}.`, proceed)] },
    { spans: [span("", proceed)] },
  );
  for (const file of page.round.files) {
    lines.push({ spans: [span("  "), span(file, { target: { kind: "file", change: page.change, file } })] });
  }
  return layout(lines);
}

/** What marking a file reviewed did, and where review continues. */
export type MarkReviewedResult =
  /** The file had no review pending, so nothing was recorded. */
  | { readonly kind: "nothing-left" }
  /**
   * The file is being marked reviewed at the end of its earliest pending
   * round. `next` is the round's next file in list order, wrapping past the
   * end for files skipped earlier; undefined when the round is done, where
   * the review page takes over — what to read next changes shape there.
   * `snapshot` has the file marked off, ready to render those pages from.
   */
  | {
      readonly kind: "marked";
      readonly next: FilePath | undefined;
      readonly snapshot: ChangeSnapshot;
      readonly recorded: Promise<void>;
    };

/**
 * Mark `file` reviewed at the end of its earliest pending round in
 * `snapshot` — exactly the round the caller's page displayed.
 *
 * The plan costs no queries, and the append rides behind `recorded`: a host
 * may open `next`'s diff immediately, because a review entry only changes
 * its own file's view, and concurrent appends commute (`appendLog` re-reads
 * and retries a lost swap). A host that moves on early owes the user the
 * rejection — and a fresh snapshot afterwards, since only the entry that
 * landed is what other readers see.
 */
export function markReviewed(
  backend: Backend,
  now: () => TimestampMs,
  snapshot: ChangeSnapshot,
  file: FilePath,
): MarkReviewedResult {
  const round = snapshot.rounds.find(({ files }) => files.has(file));
  if (round === undefined) {
    return { kind: "nothing-left" };
  }
  const recorded = backend.appendLog(snapshot.change, [
    { timestamp: now(), user: snapshot.user, action: { kind: "review", file, base: snapshot.base, tip: round.end } },
  ]);
  const rounds = snapshot.rounds.flatMap((other) => {
    if (other !== round) {
      return [other];
    }
    const files = new Map(other.files);
    files.delete(file);
    return files.size === 0 ? [] : [{ end: other.end, files }];
  });
  const remaining = [...round.files.keys()].filter((other) => other !== file);
  return {
    kind: "marked",
    next: remaining.find((other) => other > file) ?? remaining[0],
    snapshot: { ...snapshot, rounds },
    recorded,
  };
}

/** One file's diff left to review in its earliest pending round. */
export interface DiffPage {
  readonly change: RefName;
  readonly file: FilePath;
  /** Undefined when the file has no review left. */
  readonly round:
    | {
        /** The revision the round reviews up to: marking the file reviewed records `{base, tip: end}`. */
        readonly end: CommitHash;
        /** Rounds after this one that still include the file. */
        readonly later: number;
        readonly view: DiffView;
      }
    | undefined;
}

/** Query the diff page for `file`: `snapshot`'s rounds locate the diff, and only the file contents are read. */
export async function diffPage(backend: Backend, snapshot: ChangeSnapshot, file: FilePath): Promise<DiffPage> {
  const { change, base } = snapshot;
  let found: { end: CommitHash; view: FileView } | undefined;
  let later = 0;
  for (const { end, files } of snapshot.rounds) {
    const view = files.get(file);
    if (view === undefined) {
      continue;
    }
    if (found === undefined) {
      found = { end, view };
    } else {
      later++;
    }
  }
  if (found === undefined) {
    return { change, file, round: undefined };
  }
  const { end, view } = found;
  const two = async (from: CommitHash): Promise<DiffView> => {
    const [prev, next] = await Promise.all([backend.readFile(from, file), backend.readFile(end, file)]);
    return { kind: "two", prev, next };
  };
  switch (view.kind) {
    case "span":
      return { change, file, round: { end, later, view: await two(view.start) } };
    case "rewritten":
      return { change, file, round: { end, later, view: await two(view.from) } };
    case "rebased":
      return { change, file, round: { end, later, view: await rebasedView(backend, file, view.reviewed, base, end) } };
  }
}

/** The line and changed-word styles of one side of a two-way diff. */
type DiffSide = { readonly line: Style; readonly word: Style };
const removedSide: DiffSide = { line: "removed", word: "removed-word" };
const addedSide: DiffSide = { line: "added", word: "added-word" };

type SegmentTag = PatdiffCore.StructuredLine[0];

/** One line's segments with empties dropped and same-tag neighbors merged —
    refinement's bookkeeping splits, which a display has no use for. */
function mergedParts(segments: readonly PatdiffCore.StructuredLine[]): { text: string; tag: SegmentTag }[] {
  const parts: { text: string; tag: SegmentTag }[] = [];
  for (const [tag, text] of segments) {
    if (text === "") {
      continue;
    }
    const last = parts.at(-1);
    if (last !== undefined && last.tag === tag) {
      last.text += text;
    } else {
      parts.push({ text, tag });
    }
  }
  return parts;
}

/**
 * Spans for one side of a replaced line, from patdiff's refinement of it
 * into kept and changed words. Changed words carry the side's word style
 * over the line's own — but only when the line keeps something: with nothing
 * kept, there is nothing for emphasis to set the changed words apart from,
 * so the line stays one plain span. The target rides the first span alone; a
 * line resolves to its first target.
 */
function changedLineSpans(
  segments: readonly PatdiffCore.StructuredLine[],
  side: DiffSide,
  jump: { target: Target; tier: TargetTier },
): Span[] {
  const parts = mergedParts(segments);
  if (!parts.some(({ tag }) => tag !== "Same") || !parts.some(({ tag }) => tag === "Same")) {
    return [span(parts.map(({ text }) => text).join(""), { style: side.line, ...jump })];
  }
  return parts.map(({ text, tag }, i) =>
    span(text, { style: tag === "Same" ? side.line : side.word, ...(i === 0 ? jump : {}) }),
  );
}

/**
 * Spans for a unified line — one that patdiff shows once because only one
 * side of it changed words: kept text stays plain while deleted and inserted
 * words carry the word styles, as the ANSI renderer paints it.
 */
function unifiedLineSpans(
  segments: readonly PatdiffCore.StructuredLine[],
  jump: { target: Target; tier: TargetTier },
): Span[] {
  const parts = mergedParts(segments);
  if (parts.length === 0) {
    return [span("", jump)];
  }
  return parts.map(({ text, tag }, i) =>
    span(text, {
      ...(tag === "Same" ? {} : { style: tag === "Prev" ? removedSide.word : addedSide.word }),
      ...(i === 0 ? jump : {}),
    }),
  );
}

/**
 * Walk a two-way diff tracking where each hunk line sits in the file's new
 * copy, so the cursor can jump from the diff to the file itself. A hunk
 * header carries the new side's start; context and added lines advance it,
 * and a removed line anchors at the removal site without advancing. Lines
 * carry bare code a host can syntax-highlight and a reviewer can copy; the
 * added/removed styles say which side. A line only one side of which changed
 * words shows once, unified, with just those words styled; the pair form
 * remains for lines whose both sides changed words, which need both versions
 * shown. Long-line splitting stays off — it would break the
 * line-per-source-line mapping structured hosts rely on. Consecutive hunks
 * would read as one run of code, so a styled header and a blank line mark
 * where each begins.
 */
function twoWayDiffLines(file: FilePath, view: Extract<DiffView, { kind: "two" }>, context?: number): Line[] {
  if (IsBinary.string(view.prev ?? "") || IsBinary.string(view.next ?? "")) {
    return view.prev === view.next ? [] : [{ spans: [span(`Binary versions of ${file} differ`)] }];
  }
  const hunks = PatdiffCore.withoutUnix.patdiffStructured({
    context: context ?? defaultContext,
    produceUnifiedLines: true,
    splitLongLines: false,
    // Names are never printed, but patdiff's language-specific whitespace
    // heuristics read them.
    prev: { name: file, text: view.prev ?? "" },
    next: { name: file, text: view.next ?? "" },
  });
  const lines: Line[] = [];
  for (const hunk of hunks) {
    if (lines.length > 0) {
      lines.push({ spans: [] });
    }
    let at = hunk.nextStart;
    // Jump tier: a wall of clickable diff lines would drown the page's real
    // links, and the cursor is already on the line a reviewer wants to visit.
    const jump = (): { target: Target; tier: TargetTier } => ({
      target: { kind: "location", file, line: at },
      tier: "jump",
    });
    const header = `-${hunk.prevStart},${hunk.prevSize} +${hunk.nextStart},${hunk.nextSize}`;
    lines.push({ spans: [span(header, { style: "hunk", ...jump() })] });
    for (const range of hunk.ranges) {
      switch (range.kind) {
        case "same":
          for (const [, next] of range.contents) {
            lines.push({ spans: [span(next.map(([, text]) => text).join(""), jump())] });
            at++;
          }
          break;
        case "prev":
          for (const segments of range.contents) {
            lines.push({ spans: changedLineSpans(segments, removedSide, jump()) });
          }
          break;
        case "next":
          for (const segments of range.contents) {
            lines.push({ spans: changedLineSpans(segments, addedSide, jump()) });
            at++;
          }
          break;
        case "replace":
          for (const segments of range.prev) {
            lines.push({ spans: changedLineSpans(segments, removedSide, jump()) });
          }
          for (const segments of range.next) {
            lines.push({ spans: changedLineSpans(segments, addedSide, jump()) });
            at++;
          }
          break;
        case "unified":
          for (const segments of range.contents) {
            lines.push({ spans: unifiedLineSpans(segments, jump()) });
            // A line's final segment holds the tag of the newline that ended
            // it. A boundary only the old copy had — deleting words joined
            // two lines — leaves the cursor on the same line of the new copy.
            if (segments.at(-1)?.[0] !== "Prev") {
              at++;
            }
          }
          break;
      }
    }
  }
  return lines;
}

/**
 * A 4-way render already knows each line's home in the four versions; the
 * new tip is the copy a reviewer visits, so lines carrying one jump straight
 * to it. Lines absent from the new tip anchor at the running insertion point,
 * like a two-way removal; decoration (view titles, grouping pipes) resets the
 * point so one view's anchor cannot leak into views that never touch the new
 * tip. Hunk headers anchor without advancing. Unlike two-way lines, these
 * keep their sign marks: a ddiff line's stacked signs say more than one
 * style can express.
 */
function fourWayDiffLines(file: FilePath, view: Extract<DiffView, { kind: "four" }>, context?: number): Line[] {
  const rendered = renderDiff4({ file, revs: view.revs, contents: view.contents, color: false, context });
  let at: number | undefined;
  return rendered.map(({ text, kind, provenance }) => {
    const opts: { style?: Style; target?: Target; tier?: TargetTier } = {};
    if (kind === "prev") {
      opts.style = "removed";
    } else if (kind === "next") {
      opts.style = "added";
    }
    if (provenance.f2 !== undefined) {
      const line = Math.max(1, provenance.f2);
      opts.target = { kind: "location", file, line };
      at = kind === undefined ? line : line + 1;
    } else if (Object.keys(provenance).length === 0) {
      at = undefined;
    } else if (at !== undefined) {
      opts.target = { kind: "location", file, line: at };
    }
    if (opts.target !== undefined) {
      // Jump tier, as in twoWayDiffLines.
      opts.tier = "jump";
    }
    return { spans: [span(text, opts)] };
  });
}

export function diffDoc(page: DiffPage, context?: number): Doc {
  // One header line, then the diff: the diff is what the reviewer came to
  // read, so the page spends no more chrome on it than that.
  const round = page.round === undefined ? "" : ` (up to ${shortHash(page.round.end)}${moreRounds(page.round.later)})`;
  const title = `${page.file} in ${page.change}${round}`;
  const lines: Line[] = [
    { spans: [span(title, { style: "heading", target: { kind: "change", change: page.change } })] },
    { spans: [] },
  ];
  if (page.round === undefined) {
    lines.push({ spans: [span("Nothing left to review.")] });
    return layout(lines);
  }
  const view = page.round.view;
  const body =
    view.kind === "two" ? twoWayDiffLines(page.file, view, context) : fourWayDiffLines(page.file, view, context);
  if (body.length === 0) {
    // A due file's diff can still render empty — a tree diff lists changes
    // patdiff shows no hunks for, like a mode-only change; marking the file
    // reviewed is how the reviewer clears it.
    lines.push({ spans: [span("No differences left to read; mark the file reviewed to record that.")] });
    return layout(lines);
  }
  lines.push(...body);
  return layout(lines);
}
