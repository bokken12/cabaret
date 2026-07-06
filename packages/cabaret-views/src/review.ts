import {
  type Backend,
  type CommitHash,
  changeBase,
  changeTip,
  type FilePath,
  type FileView,
  type RefName,
  type ReviewedDiff,
  reviewRounds,
  type UserName,
} from "cabaret-core";
import { PatdiffCore } from "patdiff";
import { IsBinary } from "patdiff/kernel";
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

export async function reviewPage(backend: Backend, user: UserName, change: RefName): Promise<ReviewPage> {
  const entries = await backend.readLog(change);
  const base = await changeBase(backend, change, entries);
  const tip = await changeTip(backend, change, entries);
  const rounds = await reviewRounds(backend, entries, user, base, tip);
  const first = rounds[0];
  return {
    change,
    round: first && { end: first.end, files: [...first.files.keys()], later: rounds.length - 1 },
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

export async function diffPage(backend: Backend, user: UserName, change: RefName, file: FilePath): Promise<DiffPage> {
  const entries = await backend.readLog(change);
  const base = await changeBase(backend, change, entries);
  const tip = await changeTip(backend, change, entries);
  let found: { end: CommitHash; view: FileView } | undefined;
  let later = 0;
  for (const { end, files } of await reviewRounds(backend, entries, user, base, tip)) {
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
  const two = async (from: CommitHash): Promise<DiffView> => ({
    kind: "two",
    prev: await backend.readFile(from, file),
    next: await backend.readFile(end, file),
  });
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
 */
export function renderDiff4(args: {
  file: FilePath;
  revs: Patdiff4.Diamond.Diamond<CommitHash>;
  contents: Patdiff4.Diamond.Diamond<string | undefined>;
  color: boolean;
}): string {
  // TODO: name absent versions distinctly (Iron renders them as <absent>
  // with a per-version file-name table) instead of diffing an empty file.
  const contents = Patdiff4.Diamond.map(args.contents, (text) => text ?? "");
  if (!Patdiff4.Diamond.forAll(contents, (text) => !IsBinary.string(text))) {
    return `Binary versions of ${args.file} differ\n`;
  }
  const lines = Patdiff4.diff({
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
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The paint a rendered ASCII diff line earns: patdiff marks the lines of a
 * hunk with a sign run ending in `|` (`+|`, `-|`, and 4-way stacks like
 * `++-|`). A two-way hunk marks at column 0, so only a mark there counts — a
 * context line's own text may begin with the same characters. A 4-way hunk
 * stacks signs behind the `|`/`_` gutter diff4 draws around hunk groups,
 * which takes a lenient match past the gutter.
 */
function diffLineStyle(text: string, kind: DiffView["kind"]): Style | undefined {
  const body = kind === "two" ? text : text.replace(/^[ |_]+/, "");
  const signs = /^[+-]*([+-])\|/.exec(body);
  return signs === null ? undefined : signs[1] === "+" ? "added" : "removed";
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
  const rendered =
    view.kind === "two"
      ? renderDiff(page.file, view.prev, view.next, false)
      : renderDiff4({ file: page.file, revs: view.revs, contents: view.contents, color: false });
  if (rendered === "") {
    // A moved base can leave nothing visible to read (the rebase carried the
    // change cleanly) while the stale review still counts the file as left;
    // marking it reviewed is how the reviewer clears it.
    lines.push({ spans: [span("No differences left to read; mark the file reviewed to record that.")] });
    return { lines };
  }
  // Walk a two-way render tracking where each hunk line sits in the file's
  // new copy, so the cursor can jump from the diff to the file itself. A hunk
  // header carries the new side's start; context and added lines advance it,
  // and a removed line anchors at the removal site without advancing. The
  // 4-way views interleave four line numberings behind per-view sign stacks,
  // so their lines get none.
  // TODO: have patdiff4 return structured hunks (per-line provenance in each
  // of the four revisions) instead of re-parsing rendered text; that gives
  // 4-way lines their new-tip targets and lets hosts draw signs outside the
  // text, where this walk cannot reach.
  let at = 1;
  for (const text of rendered.slice(0, -1).split("\n")) {
    const opts: { style?: Style; target?: Target } = {};
    const style = diffLineStyle(text, view.kind);
    if (style !== undefined) {
      opts.style = style;
    }
    if (view.kind === "two") {
      const header = /^-\d+,\d+ \+(\d+),\d+$/.exec(text);
      if (header?.[1] !== undefined) {
        at = Number(header[1]);
        opts.target = { kind: "location", file: page.file, line: at };
      } else if (text.startsWith("+|") || text.startsWith("  ")) {
        opts.target = { kind: "location", file: page.file, line: at };
        at++;
      } else if (text.startsWith("-|")) {
        opts.target = { kind: "location", file: page.file, line: at };
      }
    }
    lines.push({ spans: [span(text, opts)] });
  }
  return { lines };
}
