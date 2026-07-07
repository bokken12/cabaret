import {
  type Backend,
  type CommitHash,
  changeBase,
  changeTip,
  type FilePath,
  type FileView,
  type RefName,
  type ReviewedDiff,
  type ReviewRound,
  reviewRounds,
  type TimestampMs,
  type UserName,
} from "cabaret-core";
// The kernel entry, not `patdiff`, whose Node-flavored PatdiffCore reads the
// filesystem and console — imports a browser host cannot load.
import { IsBinary, PatdiffCore } from "patdiff/kernel";
import * as Patdiff4 from "patdiff/patdiff4";
import { type Doc, type Line, type Style, span, type Target } from "./doc.js";

/** Hashes display abbreviated; full hashes travel in targets, never prose. */
function shortHash(hash: CommitHash): string {
  return hash.slice(0, 12);
}

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
  const [base, tip, user] = await Promise.all([
    changeBase(backend, change, entries),
    changeTip(backend, change, entries),
    backend.currentUser(),
  ]);
  return { change, user, base, tip, rounds: await reviewRounds(backend, entries, user, base, tip) };
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
  const lines: Line[] = [
    { spans: [span(title, { style: "heading", target: { kind: "change", change: page.change } })] },
    { spans: [span("=".repeat(title.length))] },
    { spans: [] },
  ];
  if (page.round === undefined) {
    lines.push({ spans: [span("Nothing left to review.")] });
    return { lines };
  }
  lines.push(
    { spans: [span(`Reviewing up to ${shortHash(page.round.end)}${moreRounds(page.round.later)}.`)] },
    { spans: [] },
  );
  for (const file of page.round.files) {
    lines.push({ spans: [span("  "), span(file, { target: { kind: "file", change: page.change, file } })] });
  }
  return { lines };
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

/** The versions a file's round of review compares. */
export type DiffView =
  /** A plain two-way diff; an absent version diffs against the empty file. */
  | { readonly kind: "two"; readonly prev: string | undefined; readonly next: string | undefined }
  /** The base's copy changed under the review: a 4-way diff of the reviewed and current diffs. */
  | {
      readonly kind: "four";
      readonly revs: Patdiff4.Diamond.Diamond<CommitHash>;
      readonly contents: Patdiff4.Diamond.Diamond<string | undefined>;
    };

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

/**
 * The view of a file whose base moved under its review. The two-way diff from
 * the reviewed tip stays sound when the base's copy is unchanged (the
 * reviewed diff's start is intact) or the new base took the reviewed tip's
 * copy (the whole new diff starts at contents the reviewer knows); otherwise
 * the base's copy changed underneath the review, which takes a 4-way diff.
 */
async function rebasedView(
  backend: Backend,
  file: FilePath,
  reviewed: ReviewedDiff,
  base: CommitHash,
  end: CommitHash,
): Promise<DiffView> {
  const [prevBase, nextBase, prevTip, nextTip] = await Promise.all([
    backend.readFile(reviewed.base, file),
    backend.readFile(base, file),
    backend.readFile(reviewed.tip, file),
    backend.readFile(end, file),
  ]);
  return prevBase === nextBase || nextBase === prevTip
    ? { kind: "two", prev: prevTip, next: nextTip }
    : {
        kind: "four",
        revs: { b1: reviewed.base, b2: base, f1: reviewed.tip, f2: end },
        contents: { b1: prevBase, b2: nextBase, f1: prevTip, f2: nextTip },
      };
}

/**
 * Render the diff between two versions of `file` with patdiff: ANSI-colored
 * with word-level refinement on a terminal, plain ASCII otherwise. An absent
 * version diffs against the empty file, named /dev/null as in git.
 */
export function renderDiff(file: FilePath, prev: string | undefined, next: string | undefined, color: boolean): string {
  if (IsBinary.string(prev ?? "") || IsBinary.string(next ?? "")) {
    return prev === next ? "" : `Binary versions of ${file} differ\n`;
  }
  const prevName = prev === undefined ? "/dev/null" : `old/${file}`;
  const nextName = next === undefined ? "/dev/null" : `new/${file}`;
  const diff = PatdiffCore.withoutUnix.patdiff({
    output: color ? "Ansi" : "Ascii",
    // Unified lines are unsupported in Ascii output.
    produceUnifiedLines: color,
    // Splitting a long modified line into partial context and changed pieces
    // would break the line-per-source-line mapping structured hosts rely on.
    splitLongLines: color,
    prev: { name: prevName, text: prev ?? "" },
    next: { name: nextName, text: next ?? "" },
  });
  // patdiff's own global header prints even when no hunks survive (e.g. equal
  // contents), so an empty diff must skip the header here instead.
  return diff === "" ? "" : `${prevName}\n${nextName}\n${diff}\n`;
}

/**
 * Render what remains to review when the base's copy of `file` changed
 * underneath the reviewed diff: Iron's diff4 over the old and new base and
 * tip, each aligned hunk shown under every view its equivalence class earns.
 * Empty when nothing is left to show.
 */
export function renderDiff4(args: {
  file: FilePath;
  revs: Patdiff4.Diamond.Diamond<CommitHash>;
  contents: Patdiff4.Diamond.Diamond<string | undefined>;
  color: boolean;
}): readonly Patdiff4.Line[] {
  // TODO: name absent versions distinctly (Iron renders them as <absent>
  // with a per-version file-name table) instead of diffing an empty file.
  const contents = Patdiff4.Diamond.map(args.contents, (text) => text ?? "");
  if (!Patdiff4.Diamond.forAll(contents, (text) => !IsBinary.string(text))) {
    return [{ text: `Binary versions of ${args.file} differ`, kind: undefined, provenance: {} }];
  }
  return Patdiff4.diff({
    // Hash prefixes keep patdiff4's contract that equal names imply equal
    // contents, where "old"/"new" labels would not (the tips can coincide).
    revNames: Patdiff4.Diamond.map(args.revs, shortHash),
    fileNames: Patdiff4.Diamond.singleton(args.file),
    headerFileName: args.file,
    context: PatdiffCore.defaultContext,
    linesRequiredToSeparateDdiffHunks: 0,
    contents,
    output: args.color ? "Ansi" : "Ascii",
  });
}

/**
 * Walk a two-way render tracking where each hunk line sits in the file's new
 * copy, so the cursor can jump from the diff to the file itself. A hunk
 * header carries the new side's start; context and added lines advance it,
 * and a removed line anchors at the removal site without advancing. Hunk
 * lines shed their two-column marks — the added/removed styles carry the
 * same information — leaving bare code a host can syntax-highlight and a
 * reviewer can copy. Only a mark at column 0 counts as one — a context
 * line's own text may begin with the same characters.
 */
function twoWayDiffLines(file: FilePath, view: Extract<DiffView, { kind: "two" }>): Line[] {
  const rendered = renderDiff(file, view.prev, view.next, false);
  if (rendered === "") {
    return [];
  }
  const lines: Line[] = [];
  let at = 1;
  for (const text of rendered.slice(0, -1).split("\n")) {
    const opts: { style?: Style; target?: Target } = {};
    let content = text;
    const header = /^-\d+,\d+ \+(\d+),\d+$/.exec(text);
    if (header?.[1] !== undefined) {
      at = Number(header[1]);
      opts.target = { kind: "location", file, line: at };
    } else if (text.startsWith("+|")) {
      opts.style = "added";
      opts.target = { kind: "location", file, line: at };
      at++;
      content = text.slice(2);
    } else if (text.startsWith("  ")) {
      opts.target = { kind: "location", file, line: at };
      at++;
      content = text.slice(2);
    } else if (text.startsWith("-|")) {
      opts.style = "removed";
      opts.target = { kind: "location", file, line: at };
      content = text.slice(2);
    }
    lines.push({ spans: [span(content, opts)] });
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
function fourWayDiffLines(file: FilePath, view: Extract<DiffView, { kind: "four" }>): Line[] {
  const rendered = renderDiff4({ file, revs: view.revs, contents: view.contents, color: false });
  let at: number | undefined;
  return rendered.map(({ text, kind, provenance }) => {
    const opts: { style?: Style; target?: Target } = {};
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
    return { spans: [span(text, opts)] };
  });
}

export function diffDoc(page: DiffPage): Doc {
  // One header line, then the diff: the diff is what the reviewer came to
  // read, so the page spends no more chrome on it than that.
  const context =
    page.round === undefined ? "" : ` (up to ${shortHash(page.round.end)}${moreRounds(page.round.later)})`;
  const title = `${page.file} in ${page.change}${context}`;
  const lines: Line[] = [
    { spans: [span(title, { style: "heading", target: { kind: "change", change: page.change } })] },
    { spans: [] },
  ];
  if (page.round === undefined) {
    lines.push({ spans: [span("Nothing left to review.")] });
    return { lines };
  }
  const view = page.round.view;
  const body = view.kind === "two" ? twoWayDiffLines(page.file, view) : fourWayDiffLines(page.file, view);
  if (body.length === 0) {
    // A moved base can leave nothing visible to read (the rebase carried the
    // change cleanly) while the stale review still counts the file as left;
    // marking it reviewed is how the reviewer clears it.
    lines.push({ spans: [span("No differences left to read; mark the file reviewed to record that.")] });
    return { lines };
  }
  lines.push(...body);
  return { lines };
}
