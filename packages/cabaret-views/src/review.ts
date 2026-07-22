import {
  assertNoConflict,
  type Backend,
  type ChangedFile,
  type ChangeId,
  type ChangeName,
  changeConflicts,
  changeDiff,
  currentName,
  currentReviewing,
  type DiffView,
  defaultContext,
  type FilePath,
  type FileSource,
  fileLabel,
  lookupChange,
  mayRecordReview,
  NotReviewingError,
  type Reviewing,
  type ReviewLeft,
  type Revision,
  rebasedView,
  reviewLeft,
  reviewLeftFiles,
  selfAs,
  shortHash,
  structuredDiff4,
  type TimestampMs,
  UserError,
  type UserName,
} from "cabaret-core";
// The kernel entry, not `patdiff`, whose Node-flavored PatdiffCore reads the
// filesystem and console — imports a browser host cannot load.
import { IsBinary, PatdiffCore } from "patdiff/kernel";
import * as Patdiff4 from "patdiff/patdiff4";
import {
  type Doc,
  type Line,
  layout,
  type Node,
  type Span,
  type Style,
  section,
  span,
  type Target,
  type TargetTier,
} from "./doc.js";

/**
 * One reading of a change's review state: everything the review and diff
 * pages derive their content from, queried once. Pages rendered from one
 * snapshot agree with each other, and a mark records exactly what its
 * snapshot displayed — a commit racing the keypress cannot widen the marked
 * diff. A host chooses how long to keep one: fresh per render, or held for a
 * whole file-by-file review pass, where going stale only means not seeing
 * review state that changed elsewhere until the next refresh.
 */
export interface ChangeSnapshot {
  /** The change's identity, where marking records review; undefined for a log-less branch, which has nowhere to record. */
  readonly id: ChangeId | undefined;
  readonly change: ChangeName;
  /** Whose review state this is: `as` when set, else the backend's current user. */
  readonly user: UserName;
  /** Set when the snapshot reads a named user's review rather than the current user's own. */
  readonly as: UserName | undefined;
  /** Who the change asks to review right now. */
  readonly reviewing: Reviewing;
  /** Whether `user` may record review without a nudge, as `mayRecordReview`. */
  readonly asked: boolean;
  readonly base: Revision;
  readonly tip: Revision;
  /** Files whose tip contents still carry conflict markers; review waits while any remain. */
  readonly conflicts: readonly FilePath[];
  readonly left: ReviewLeft;
}

export async function changeSnapshot(backend: Backend, change: ChangeName, as?: UserName): Promise<ChangeSnapshot> {
  // A log-less branch still views as a change — an empty log reads as
  // nothing reviewed — it just has no id to record review against.
  const named = await lookupChange(backend, change);
  const entries = named?.entries ?? [];
  const name = named === undefined ? change : currentName(named.id, named.entries);
  const [diff, acting] = await Promise.all([changeDiff(backend, name, entries), selfAs(backend, as)]);
  return {
    id: named?.id,
    change: name,
    user: acting.self.user,
    as: acting.as,
    reviewing: currentReviewing(entries),
    // A borrowed identity's own aliases are unknown here, so its standing may
    // read narrower than that user would see it themselves.
    asked: mayRecordReview(acting.self, name, entries),
    base: diff.base,
    tip: diff.tip,
    conflicts: await changeConflicts(backend, diff),
    left: await reviewLeft(backend, entries, acting.self.user, diff),
  };
}

/** A change's review left: what to read, up to the tip a mark records. */
export interface ReviewPage {
  readonly change: ChangeName;
  /** Whose review the page shows when not the current user's own, as `ChangeSnapshot.as`. */
  readonly as: UserName | undefined;
  /** Files with conflict markers to fix; nonempty exactly when they preempt review. */
  readonly conflicts: readonly FilePath[];
  /** Undefined when nothing is left to review, or while conflicts block it. */
  readonly left:
    | {
        /** The tip review reads up to: marking a file records `{base, tip}`. */
        readonly tip: Revision;
        /** The files left, sorted by path; a moved or copied file names its source. */
        readonly files: readonly ChangedFile[];
      }
    | undefined;
}

export function reviewPage(snapshot: ChangeSnapshot): ReviewPage {
  return {
    change: snapshot.change,
    as: snapshot.as,
    conflicts: snapshot.conflicts,
    left:
      snapshot.conflicts.length > 0 || snapshot.left.size === 0
        ? undefined
        : { tip: snapshot.tip, files: reviewLeftFiles(snapshot.left) },
  };
}

export function reviewDoc(page: ReviewPage): Doc {
  const title = page.as === undefined ? `Review ${page.change}` : `Review ${page.change} as ${page.as}`;
  // The page's whole target is proceeding with review: every line resolves
  // to the first file left, on the jump tier so only the file names read
  // as links, and a file's own line resolves to that file instead. The title
  // offers no way back to the change — here, going deeper means reviewing.
  const fileTarget = (file: FilePath): Target => ({ kind: "file", change: page.change, file, as: page.as });
  const first = page.left?.files[0];
  const proceed: { target: Target; tier: TargetTier } | undefined =
    first === undefined ? undefined : { target: fileTarget(first.path), tier: "jump" };
  const lines: Line[] = [
    { spans: [span(title, { style: "heading", ...proceed })] },
    { spans: [span("=".repeat(title.length), proceed)] },
    { spans: [span("", proceed)] },
  ];
  if (page.conflicts.length > 0) {
    lines.push({ spans: [span(`Unresolved conflicts in ${page.conflicts.join(", ")}; fix the markers and amend.`)] });
    return layout(lines);
  }
  if (page.left === undefined) {
    lines.push({ spans: [span("Nothing left to review.")] });
    return layout(lines);
  }
  lines.push(
    { spans: [span(`Reviewing up to ${shortHash(page.left.tip)}.`, proceed)] },
    { spans: [span("", proceed)] },
  );
  for (const { path, source } of page.left.files) {
    lines.push({ spans: [span("  "), span(fileLabel(path, source), { target: fileTarget(path) })] });
  }
  return layout(lines);
}

/**
 * The files beside `file` among those left, in name order — where stepping
 * up and down from its diff lands. Undefined with no review of the file
 * left; a missing side means the file ends the list.
 */
export function neighborFiles(
  left: ReviewLeft,
  file: FilePath,
): { readonly prev: FilePath | undefined; readonly next: FilePath | undefined } | undefined {
  if (!left.has(file)) {
    return undefined;
  }
  const files = [...left.keys()];
  const at = files.indexOf(file);
  return { prev: files[at - 1], next: files[at + 1] };
}

/** What marking a file reviewed did, and where review continues. */
export type MarkReviewedResult =
  /** The file had no review pending, so nothing was recorded. */
  | { readonly kind: "nothing-left" }
  /**
   * The file is being marked reviewed at the snapshot's tip. `next` is the
   * next file left in list order, wrapping past the end for files skipped
   * earlier; undefined when review is done, where hosts step back out to
   * the change's own page rather than an emptied review page. `snapshot`
   * has the file marked off, ready to render those pages from.
   */
  | {
      readonly kind: "marked";
      readonly next: FilePath | undefined;
      readonly snapshot: ChangeSnapshot;
      readonly recorded: Promise<void>;
    };

/**
 * Mark `file` reviewed at `snapshot`'s tip — exactly the diff the caller's
 * page displayed. The entry records `snapshot.user`: for a borrowed
 * snapshot that is the borrowed user, so hosts confirm intent before
 * marking through one. A snapshot with conflict markers refuses outright:
 * fixing them, not review, is the change's next step. One whose reviewing
 * set does not ask the user fails with `NotReviewingError` unless
 * `evenThoughNotReviewing`; hosts attach their own override remedy.
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
  evenThoughNotReviewing = false,
): MarkReviewedResult {
  assertNoConflict(snapshot.change, snapshot.conflicts);
  if (!snapshot.asked && !evenThoughNotReviewing) {
    throw new NotReviewingError(snapshot.change, snapshot.reviewing, snapshot.user);
  }
  if (!snapshot.left.has(file)) {
    return { kind: "nothing-left" };
  }
  if (snapshot.id === undefined) {
    throw new UserError(`${JSON.stringify(snapshot.change)} is not a change; run \`cab create\` to review it`);
  }
  const recorded = backend.appendLog(snapshot.id, [
    { timestamp: now(), user: snapshot.user, action: { kind: "review", file, base: snapshot.base, tip: snapshot.tip } },
  ]);
  const left = new Map(snapshot.left);
  left.delete(file);
  const remaining = [...left.keys()];
  return {
    kind: "marked",
    next: remaining.find((other) => other > file) ?? remaining[0],
    snapshot: { ...snapshot, left },
    recorded,
  };
}

/** One file's diff left to review. */
export interface DiffPage {
  readonly change: ChangeName;
  readonly file: FilePath;
  /** Whose review the page shows when not the current user's own, as `ChangeSnapshot.as`. */
  readonly as: UserName | undefined;
  /** Undefined when the file has no review left. */
  readonly left:
    | {
        /** The tip the diff reviews up to: marking the file reviewed records `{base, tip}`. */
        readonly tip: Revision;
        /** The source the diff moves or copies the file from, when it records one. */
        readonly source: FileSource | undefined;
        readonly view: DiffView;
      }
    | undefined;
}

/** Query the diff page for `file`: `snapshot` locates the diff, and only the file contents are read. */
export async function diffPage(backend: Backend, snapshot: ChangeSnapshot, file: FilePath): Promise<DiffPage> {
  const { change, as, base, tip } = snapshot;
  const view = snapshot.left.get(file);
  if (view === undefined) {
    return { change, file, as, left: undefined };
  }
  const two = async (from: Revision, prevPath: FilePath): Promise<DiffView> => {
    const [prev, next] = await Promise.all([backend.readFile(from, prevPath), backend.readFile(tip, file)]);
    return { kind: "two", prev, next };
  };
  switch (view.kind) {
    case "fresh":
      return { change, file, as, left: { tip, source: view.source, view: await two(base, view.source?.path ?? file) } };
    case "extend":
      return { change, file, as, left: { tip, source: undefined, view: await two(view.from, file) } };
    case "rebased":
      return {
        change,
        file,
        as,
        left: { tip, source: undefined, view: await rebasedView(backend, file, view.reviewed, base, tip) },
      };
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

/** How a line offers its place in the reviewed file, when it has one. */
type Jump = { target?: Target; tier?: TargetTier };

/**
 * Spans for one side of a replaced line, from patdiff's refinement of it
 * into kept and changed words. Changed words carry the side's word style
 * over the line's own — but only when the line keeps something: with nothing
 * kept, there is nothing for emphasis to set the changed words apart from,
 * so the line stays one plain span. The target rides the first span alone; a
 * line resolves to its first target.
 */
function changedLineSpans(segments: readonly PatdiffCore.StructuredLine[], side: DiffSide, jump: Jump): Span[] {
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
function unifiedLineSpans(segments: readonly PatdiffCore.StructuredLine[], jump: Jump): Span[] {
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
 * Walk one structured hunk's ranges into lines, tracking where each line
 * sits in the copy of the file the cursor visits. `anchor` is the 1-based
 * line of the hunk's start there — or undefined when the diff never touches
 * that copy, where lines carry no targets. Context and added lines advance
 * the anchor, and a removed line anchors at the removal site without
 * advancing. Lines carry bare code a host can syntax-highlight and a
 * reviewer can copy; the added/removed styles say which side. A line only
 * one side of which changed words shows once, unified, with just those
 * words styled; the pair form remains for lines whose both sides changed
 * words, which need both versions shown.
 */
function hunkBodyLines(
  hunk: PatdiffCore.StructuredHunks[number],
  change: ChangeName,
  file: FilePath,
  anchor: number | undefined,
): Line[] {
  let at = anchor;
  // Jump tier: a wall of clickable diff lines would drown the page's real
  // links, and the cursor is already on the line a reviewer wants to visit.
  const jump = (): Jump =>
    at === undefined ? {} : { target: { kind: "location", change, file, line: at }, tier: "jump" };
  const bump = (): void => {
    if (at !== undefined) at++;
  };
  const lines: Line[] = [];
  for (const range of hunk.ranges) {
    switch (range.kind) {
      case "same":
        for (const [, next] of range.contents) {
          lines.push({ spans: [span(next.map(([, text]) => text).join(""), jump())] });
          bump();
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
          bump();
        }
        break;
      case "replace":
        for (const segments of range.prev) {
          lines.push({ spans: changedLineSpans(segments, removedSide, jump()) });
        }
        for (const segments of range.next) {
          lines.push({ spans: changedLineSpans(segments, addedSide, jump()) });
          bump();
        }
        break;
      case "unified":
        for (const segments of range.contents) {
          lines.push({ spans: unifiedLineSpans(segments, jump()) });
          // A line's final segment holds the tag of the newline that ended
          // it. A boundary only the old copy had — deleting words joined
          // two lines — leaves the cursor on the same line of the new copy.
          if (segments.at(-1)?.[0] !== "Prev") {
            bump();
          }
        }
        break;
    }
  }
  return lines;
}

/**
 * A two-way diff's lines anchor in the file's new copy, from each hunk
 * header's new-side start. Long-line splitting stays off — it would break
 * the line-per-source-line mapping structured hosts rely on. Consecutive
 * hunks would read as one run of code, so a blank line separates them and
 * each is a section folding down to its styled header.
 */
function twoWayDiffNodes(
  change: ChangeName,
  file: FilePath,
  view: Extract<DiffView, { kind: "two" }>,
  context?: number,
): Node[] {
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
  const nodes: Node[] = [];
  for (const hunk of hunks) {
    if (nodes.length > 0) {
      nodes.push({ spans: [] });
    }
    const header = `-${hunk.prevStart},${hunk.prevSize} +${hunk.nextStart},${hunk.nextSize}`;
    const jump: Jump = { target: { kind: "location", change, file, line: hunk.nextStart }, tier: "jump" };
    const heading: Line = { spans: [span(header, { style: "hunk", ...jump })] };
    nodes.push(section(heading, hunkBodyLines(hunk, change, file, hunk.nextStart)));
  }
  return nodes;
}

const roleNames = Patdiff4.Diamond.prettyShortRevNamesConst;
/** The diamond's versions in reading order: bases before tips, old before new. */
const roleOrder: readonly Patdiff4.Diamond.Node[] = ["b1", "f1", "b2", "f2"];

const sliceText = (slice: Patdiff4.Slice.Slice): string =>
  slice.lines.length === 0 ? "" : `${slice.lines.join("\n")}\n`;

/** The second-channel style of a conflict's ddiff line: which diff carries
 *  it crossed with the inner diff's own sign. Lines both diffs agree on wear
 *  the plain two-way styles. */
function ddiffStyle(line: Patdiff4.DiffAlgo.DdiffLine): Style | undefined {
  if (line.diff === "both") {
    return line.kind === "prev" ? "removed" : line.kind === "next" ? "added" : undefined;
  }
  const sign = line.kind === "prev" ? "removed" : line.kind === "next" ? "added" : "context";
  return `${line.diff}-diff-${sign}`;
}

/**
 * A 4-way diff renders each aligned hunk under its class's view: hint
 * sentences as headings, then plain 2-way diffs of the class-chosen version
 * pairs — each hunk a foldable section under a header naming the pair — or,
 * for a true conflict, the feature ddiff's lines styled on two channels.
 * Lines anchor to their home in the new tip where they have one: added and
 * context lines directly, removed lines at the running insertion point, and
 * blocks that never touch the new tip not at all.
 */
function fourWayDiffNodes(
  change: ChangeName,
  file: FilePath,
  view: Extract<DiffView, { kind: "four" }>,
  context?: number,
): Node[] {
  if (!Patdiff4.Diamond.forAll(view.contents, (text) => !IsBinary.string(text ?? ""))) {
    return [{ spans: [span(`Binary versions of ${file} differ`)] }];
  }
  const hunks = structuredDiff4({ revs: view.revs, contents: view.contents, context });
  const nodes: Node[] = [];
  const blank = (): void => {
    if (nodes.length > 0) nodes.push({ spans: [] });
  };
  const hintLine = (hint: string): Line => ({ spans: [span(hint, { style: "heading" })] });
  for (const hunk of hunks) {
    const groups = Patdiff4.Diamond.group(
      Patdiff4.Diamond.init((node) => node),
      hunk.diff4Class,
    );
    const nameOf = (node: Patdiff4.Diamond.Node): string => {
      const grouped = Patdiff4.Diamond.get(groups, node);
      return roleOrder
        .filter((other) => grouped.includes(other))
        .map((other) => Patdiff4.Diamond.get(roleNames, other))
        .join(", ");
    };
    for (const block of hunk.blocks) {
      if (block.kind === "diff2") {
        const from = Patdiff4.Diamond.get(hunk.slices, block.from);
        const to = Patdiff4.Diamond.get(hunk.slices, block.to);
        const inner = PatdiffCore.withoutUnix.patdiffStructured({
          context: context ?? defaultContext,
          produceUnifiedLines: true,
          splitLongLines: false,
          prev: { name: file, text: sliceText(from) },
          next: { name: file, text: sliceText(to) },
        });
        // Classification found the slices unequal under the same whitespace-
        // insensitive diff, so the block's own diff cannot come back empty.
        if (inner.length === 0) {
          throw new Error(`empty ${block.from}->${block.to} diff for a ${hunk.diff4Class} hunk of ${file}`);
        }
        blank();
        nodes.push(...block.hints.map(hintLine));
        // The new tip is the copy a reviewer visits; a block whose to-side
        // coincides with it anchors there, sharing the to-side's positions.
        const anchored = Patdiff4.Diamond.get(groups, block.to).includes("f2");
        const f2Start = hunk.slices.f2.range.lineStart;
        inner.forEach((ih, i) => {
          if (i > 0) nodes.push({ spans: [] });
          const anchor = anchored ? f2Start + ih.nextStart : undefined;
          const header =
            `-${from.range.lineStart + ih.prevStart},${ih.prevSize}` +
            ` +${to.range.lineStart + ih.nextStart},${ih.nextSize}` +
            ` ${nameOf(block.from)} → ${nameOf(block.to)}`;
          const jump: Jump =
            anchor === undefined ? {} : { target: { kind: "location", change, file, line: anchor }, tier: "jump" };
          const heading: Line = { spans: [span(header, { style: "hunk", ...jump })] };
          nodes.push(section(heading, hunkBodyLines(ih, change, file, anchor)));
        });
      } else {
        if (block.lines.length === 0) continue;
        blank();
        let at: number | undefined;
        const body: Line[] = block.lines.map((line) => {
          const style = ddiffStyle(line);
          const f2 = line.provenance.f2;
          let jump: Jump = {};
          if (f2 !== undefined) {
            jump = { target: { kind: "location", change, file, line: f2 }, tier: "jump" };
            at = f2 + 1;
          } else if (at !== undefined) {
            jump = { target: { kind: "location", change, file, line: at }, tier: "jump" };
          }
          return { spans: [span(line.content, { style, ...jump })] };
        });
        const [first, ...rest] = block.hints;
        nodes.push(...(first === undefined ? body : [section(hintLine(first), [...rest.map(hintLine), ...body])]));
      }
    }
  }
  return nodes;
}

/**
 * The note standing in for hunks when a due file's diff renders empty: what
 * the tree records that the hunks cannot show — a pure move or copy, a mode
 * change, or a file created or deleted with nothing visible inside. Marking
 * the file reviewed is how the reviewer clears it either way.
 */
export function emptyDiffNote(source: FileSource | undefined, view: DiffView): string {
  if (source !== undefined) {
    return `${source.copied ? "Copied" : "Moved"} with no content changes.`;
  }
  if (view.kind === "two") {
    if (view.prev === undefined) {
      return "File created.";
    }
    if (view.next === undefined) {
      return "File deleted.";
    }
    if (view.prev === view.next) {
      return "File mode changed.";
    }
  }
  return "No differences left to read.";
}

/** One file's diff body: its hunks, or the note that nothing is left to read there. */
function fileBodyNodes(
  change: ChangeName,
  file: FilePath,
  source: FileSource | undefined,
  view: DiffView,
  context?: number,
): Node[] {
  const body =
    view.kind === "two" ? twoWayDiffNodes(change, file, view, context) : fourWayDiffNodes(change, file, view, context);
  if (body.length === 0) {
    return [{ spans: [span(emptyDiffNote(source, view))] }];
  }
  return body;
}

export function diffDoc(page: DiffPage, context?: number): Doc {
  // One header line, then the diff: the diff is what the reviewer came to
  // read, so the page spends no more chrome on it than that.
  const upTo = page.left === undefined ? "" : ` (up to ${shortHash(page.left.tip)})`;
  const name = fileLabel(page.file, page.left?.source);
  const title = `${name} in ${page.change}${page.as === undefined ? "" : ` as ${page.as}`}${upTo}`;
  const nodes: Node[] = [
    { spans: [span(title, { style: "heading", target: { kind: "change", change: page.change } })] },
    { spans: [] },
  ];
  if (page.left === undefined) {
    nodes.push({ spans: [span("Nothing left to review.")] });
    return layout(nodes);
  }
  nodes.push(...fileBodyNodes(page.change, page.file, page.left.source, page.left.view, context));
  return layout(nodes);
}

/** Every file of a change's review left, diffed in one page. */
export interface DiffsPage {
  readonly change: ChangeName;
  /** Whose review the page shows when not the current user's own, as `ChangeSnapshot.as`. */
  readonly as: UserName | undefined;
  /** Files with conflict markers to fix; nonempty exactly when they preempt review. */
  readonly conflicts: readonly FilePath[];
  /** Undefined when nothing is left to review, or while conflicts block it. */
  readonly left:
    | {
        /** The tip the diffs review up to: marking a file records `{base, tip}`. */
        readonly tip: Revision;
        readonly files: readonly {
          readonly file: FilePath;
          /** The source the diff moves or copies the file from, when it records one. */
          readonly source: FileSource | undefined;
          readonly view: DiffView;
        }[];
      }
    | undefined;
}

/** Query the diffs page: one `diffPage` view per file left. */
export async function diffsPage(backend: Backend, snapshot: ChangeSnapshot): Promise<DiffsPage> {
  const { change, as, conflicts } = snapshot;
  if (conflicts.length > 0 || snapshot.left.size === 0) {
    return { change, as, conflicts, left: undefined };
  }
  const files = await Promise.all(
    [...snapshot.left.keys()].map(async (file) => {
      const page = await diffPage(backend, snapshot, file);
      if (page.left === undefined) {
        throw new Error(`${file} is left to review in ${change} but has no diff`);
      }
      return { file, source: page.left.source, view: page.left.view };
    }),
  );
  return { change, as, conflicts, left: { tip: snapshot.tip, files } };
}

/**
 * The bar naming a file above its hunks, as patdiff prints one. At least
 * three @s a side keeps a long path's bar reading as a bar — and matching
 * the page grammar's file-section pattern.
 */
function fileBar(name: string): string {
  const padded = ` ${name} `;
  const left = Math.max(3, Math.floor((84 - padded.length) / 2));
  const right = Math.max(3, 84 - padded.length - left);
  return "@".repeat(left) + padded + "@".repeat(right);
}

export function diffsDoc(page: DiffsPage, context?: number): Doc {
  const upTo = page.left === undefined ? "" : ` (up to ${shortHash(page.left.tip)})`;
  const title = `Review ${page.change}${page.as === undefined ? "" : ` as ${page.as}`}${upTo}`;
  const nodes: Node[] = [
    { spans: [span(title, { style: "heading", target: { kind: "change", change: page.change } })] },
    { spans: [] },
  ];
  if (page.conflicts.length > 0) {
    nodes.push({ spans: [span(`Unresolved conflicts in ${page.conflicts.join(", ")}; fix the markers and amend.`)] });
    return layout(nodes);
  }
  if (page.left === undefined) {
    nodes.push({ spans: [span("Nothing left to review.")] });
    return layout(nodes);
  }
  page.left.files.forEach(({ file, source, view }, i) => {
    if (i > 0) {
      nodes.push({ spans: [] });
    }
    const heading: Line = {
      spans: [
        span(fileBar(fileLabel(file, source)), {
          style: "heading",
          target: { kind: "file", change: page.change, file, as: page.as },
        }),
      ],
    };
    nodes.push(section(heading, fileBodyNodes(page.change, file, source, view, context)));
  });
  return layout(nodes);
}
