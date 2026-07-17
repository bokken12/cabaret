import {
  type Backend,
  brain,
  type ChangeDiff,
  type ChangeName,
  changeConflicts,
  currentArchived,
  currentForgeChange,
  currentOwner,
  currentParent,
  currentReviewers,
  currentReviewing,
  type FilePath,
  type ForgeChangeId,
  type ForgeLocator,
  type LandMerge,
  type LogEntry,
  landedMerge,
  observedForgeParent,
  type ReviewedDiff,
  type Reviewing,
  type Revision,
  remainingSpans,
  type UserName,
} from "./backend.js";
import { type DiffView, diffViewEmpty, rebasedView } from "./diff.js";
import { UserError } from "./error.js";

/** A change and the changes parented on it. */
export interface ChangeNode {
  readonly change: ChangeName;
  readonly children: readonly ChangeNode[];
}

/**
 * Arrange changes into a forest by their parent links. Roots are the changes
 * whose parent is not itself a change (typically a trunk branch like `main`);
 * roots and children sort by name. Parent links that form a cycle leave their
 * members reachable from no root, which is an error.
 */
export function changeForest(parents: ReadonlyMap<ChangeName, ChangeName>): readonly ChangeNode[] {
  const byParent = new Map<ChangeName, ChangeName[]>();
  for (const [change, parent] of parents) {
    const siblings = byParent.get(parent);
    if (siblings === undefined) {
      byParent.set(parent, [change]);
    } else {
      siblings.push(change);
    }
  }
  const reached = new Set<ChangeName>();
  const build = (change: ChangeName): ChangeNode => {
    reached.add(change);
    const children = (byParent.get(change) ?? []).sort().map(build);
    return { change, children };
  };
  const forest = [...parents.entries()]
    .filter(([, parent]) => !parents.has(parent))
    .map(([change]) => change)
    .sort()
    .map(build);
  if (reached.size !== parents.size) {
    const cyclic = [...parents.keys()].filter((change) => !reached.has(change)).sort();
    throw new UserError(`parent links form a cycle among: ${cyclic.join(", ")}`);
  }
  return forest;
}

/** What must happen next to move a change toward landing. */
export type NextStep =
  | "pull"
  | "resolve divergence"
  | "reparent"
  | "fix conflicts"
  | "add code"
  | "review"
  | "add reviewers"
  | "widen reviewing"
  | "pull parent"
  | "resolve parent divergence"
  | "rebase"
  | "push"
  | "land"
  | "landed"
  | "archived";

/** A change's status at a glance, computed from its log for one user. */
export interface ChangeSummary {
  readonly change: ChangeName;
  readonly parent: ChangeName;
  readonly owner: UserName;
  /** The change's reviewers, sorted by name. */
  readonly reviewers: readonly UserName[];
  /** Who is asked to review right now. */
  readonly reviewing: Reviewing;
  readonly forgeChange:
    | {
        readonly forge: ForgeLocator;
        readonly id: ForgeChangeId;
        /** The parent the forge was last seen merging into, when it is not the change's. */
        readonly staleParent: ChangeName | undefined;
      }
    | undefined;
  /** The merge that landed the change, or undefined if it has not landed. */
  readonly landed: Revision | undefined;
  /** The changes landed into this one, oldest first. */
  readonly included: readonly LandMerge[];
  /** Whether the change is archived: set aside as not landing, reversibly. */
  readonly archived: boolean;
  readonly base: Revision;
  readonly tip: Revision;
  /** How the tip stands relative to origin's last-fetched copy, when they differ. */
  readonly origin: "ahead" | "behind" | "diverged" | undefined;
  /** What became of a parent that can no longer be built on. */
  readonly deadParent: "landed" | "missing" | undefined;
  /** How the parent's local tip stands relative to origin's last-fetched copy, when it trails. */
  readonly parentOrigin: "behind" | "diverged" | undefined;
  /** How the base stands relative to a live parent's tip, when they differ. */
  readonly staleBase: "behind" | "diverged" | undefined;
  /** Files whose contents at the tip still carry conflict markers, sorted by name. */
  readonly conflicts: readonly FilePath[];
  /** Files with review left for the user, sorted by name. */
  readonly reviewLeft: readonly FilePath[];
  readonly nextStep: NextStep;
}

/**
 * Summarize `change` for `user`. `entries` must be `change`'s log and `diff`
 * its diff; taking them explicitly lets callers batch one read of every log
 * into both the parent links `changeForest` wants and these summaries, and
 * share one diff reading with the obligations computed beside them.
 */
export async function summarizeChange(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry[],
  user: UserName,
  diff: ChangeDiff,
): Promise<ChangeSummary> {
  const parent = currentParent(change, entries);
  const landed = landedMerge(entries);
  const tracked = currentForgeChange(entries);
  const { base, tip } = diff;
  const rounds = await reviewRounds(backend, entries, user, diff);
  const reviewLeft = [...new Set(rounds.flatMap(({ files }) => [...files.keys()]))].sort();
  // A landed change is frozen, so nothing about its surroundings bears on it.
  // These are all local readings — origin's tip is whatever was last fetched
  // — so summarizing never makes a remote query.
  let origin: ChangeSummary["origin"];
  let staleParent: ChangeName | undefined;
  let deadParent: ChangeSummary["deadParent"];
  let parentOrigin: ChangeSummary["parentOrigin"];
  let stale: { readonly kind: NonNullable<ChangeSummary["staleBase"]>; readonly parentTip: Revision } | undefined;
  if (landed === undefined) {
    if (tracked !== undefined) {
      const observed = observedForgeParent(entries, tracked.forge);
      if (observed !== undefined && observed !== parent) {
        staleParent = observed;
      }
    }
    // A change with no local branch reads as origin's copy itself — trivially
    // in sync, so no reading arises, just as when a local branch matches.
    const originTip = await backend.originTip(change);
    if (originTip !== undefined && originTip !== tip) {
      origin = (await backend.isAncestor(originTip, tip))
        ? "ahead"
        : (await backend.isAncestor(tip, originTip))
          ? "behind"
          : "diverged";
    }
    if (landedMerge(await backend.readLog(parent)) !== undefined) {
      deadParent = "landed";
    } else {
      const parentTip = await backend.tip(parent);
      const parentOriginTip = await backend.originTip(parent);
      if (parentTip === undefined) {
        // A parent origin holds but this clone lacks is not dead, just unpulled.
        if (parentOriginTip === undefined) {
          deadParent = "missing";
        } else {
          parentOrigin = "behind";
        }
      } else {
        // A parent ahead of origin's copy is no reading at all: rebasing onto
        // it already covers everything origin has.
        if (
          parentOriginTip !== undefined &&
          parentOriginTip !== parentTip &&
          !(await backend.isAncestor(parentOriginTip, parentTip))
        ) {
          parentOrigin = (await backend.isAncestor(parentTip, parentOriginTip)) ? "behind" : "diverged";
        }
        if (parentTip !== base) {
          stale = { kind: (await backend.isAncestor(base, parentTip)) ? "behind" : "diverged", parentTip };
        }
      }
    }
  }
  const readings = {
    change,
    parent,
    owner: currentOwner(change, entries),
    reviewers: currentReviewers(entries),
    reviewing: currentReviewing(entries),
    forgeChange: tracked && { ...tracked, staleParent },
    landed,
    included: diff.lands,
    archived: currentArchived(entries),
    base,
    tip,
    origin,
    deadParent,
    parentOrigin,
    staleBase: stale?.kind,
    // A landed change is frozen; only live code is worth scanning for markers.
    conflicts: landed === undefined ? await changeConflicts(backend, diff) : [],
    reviewLeft,
  };
  return { ...readings, nextStep: await nextStep(backend, readings, stale) };
}

/**
 * What must happen next, from the summary's other readings. A landed change
 * is done and an archived one is set aside, so both read as their terminal
 * step before anything else. An origin the
 * tip trails outranks everything: each reading below is a question about
 * revisions this clone may lack. Behind mends by fast-forwarding — a pull —
 * while divergence is the owner's to resolve: an intentional rewrite pushes
 * with lease, an accidental one resets to origin. A change with no local
 * branch gates nothing: its readings are origin's copy already, and
 * operations that move the branch create it from that copy themselves. A
 * dead parent comes next: nothing can land until the change hangs somewhere
 * real. Unresolved
 * conflicts outrank review: markers are not code worth reading. A change
 * nobody is reviewing yet moves by widening; once the user's own review is
 * done, a reviewing set short of everyone widens next — after reviewers
 * exist to widen to. A stale base waits for review to finish — the parent
 * moving on is routine, and rebasing mid-review churns reviewers — and
 * calls for a rebase only where `land` would refuse it: when the tip no
 * longer merges cleanly onto `stale`'s parent tip. That merge is dry-run
 * only when every earlier step is settled; a land that skips a step anyway
 * (`--even-though-unreviewed`) is still safe, since `prepareLand` makes its
 * own check. The dry-run, like the rebase and land it stands for, is a
 * question about the parent's tip, so a parent whose local copy is not
 * current outranks them all: one that trails origin pulls first, and one
 * that diverged is the user's to reconcile. Last, a forge-tracked change pushes before landing when the
 * forge lags this clone — a tip ahead of origin, or a local reparent the
 * forge change's target has yet to follow — since the forge refuses to land
 * state it has not seen, while a local land reads nothing from origin and
 * lands as it stands.
 */
async function nextStep(
  backend: Backend,
  readings: Omit<ChangeSummary, "nextStep">,
  stale: { readonly parentTip: Revision } | undefined,
): Promise<NextStep> {
  if (readings.landed !== undefined) {
    return "landed";
  }
  if (readings.archived) {
    return "archived";
  }
  if (readings.origin === "behind") {
    return "pull";
  }
  if (readings.origin === "diverged") {
    return "resolve divergence";
  }
  if (readings.deadParent !== undefined) {
    return "reparent";
  }
  if (readings.conflicts.length > 0) {
    return "fix conflicts";
  }
  if (readings.tip === readings.base) {
    return "add code";
  }
  if (readings.reviewing === "none") {
    return "widen reviewing";
  }
  if (readings.reviewLeft.length > 0) {
    return "review";
  }
  if (readings.reviewing === "owner" && readings.reviewers.length === 0) {
    return "add reviewers";
  }
  if (readings.reviewing !== "everyone") {
    return "widen reviewing";
  }
  if (readings.parentOrigin === "behind") {
    return "pull parent";
  }
  if (readings.parentOrigin === "diverged") {
    return "resolve parent divergence";
  }
  if (stale !== undefined && (await backend.mergeConflicts(readings.base, readings.tip, stale.parentTip)).length > 0) {
    return "rebase";
  }
  const { forgeChange } = readings;
  return forgeChange !== undefined && (readings.origin === "ahead" || forgeChange.staleParent !== undefined)
    ? "push"
    : "land";
}

/** What a reviewer looks at to review a file in a round. */
export type FileView =
  /** The plain diff from `start` to the round's end. */
  | { readonly kind: "span"; readonly start: Revision }
  /** The base moved under the review: compare the reviewed diff with the current one. */
  | { readonly kind: "rebased"; readonly reviewed: ReviewedDiff }
  /** The reviewed tip left the change's history: diff from its contents. */
  | { readonly kind: "rewritten"; readonly from: Revision };

/** One round of review: a span of a change's history with review left in it. */
export interface ReviewRound {
  /** The revision the round reviews up to: reviewing a file here records `{base, tip: end}`. */
  readonly end: Revision;
  /** What to review per file, sorted by name. */
  readonly files: ReadonlyMap<FilePath, FileView>;
}

/** Memoize an async derivation per reviewed tip: reviews sharing a tip share what remains. */
function perTip<T>(compute: (reviewedTip: Revision) => Promise<T>): (reviewedTip: Revision) => Promise<T> {
  const memo = new Map<Revision, T>();
  return async (reviewedTip) => {
    let value = memo.get(reviewedTip);
    if (value === undefined) {
      value = await compute(reviewedTip);
      memo.set(reviewedTip, value);
    }
    return value;
  };
}

/**
 * The rounds of review left for `user` in `diff`, oldest first. Land merges
 * on the first-parent chain order review: everything before a land merge is
 * reviewed — and marked, at the round's end — before anything after it, so a
 * reviewer never reads code newer than a landing they have not absorbed. A
 * file is due in every round whose span it changes and that the user has not
 * reviewed past; a review the spans cannot place (its base moved, or its tip
 * was rewritten out of the history) puts the file's stale knowledge in its
 * earliest round's view, and later rounds assume the earlier ones get
 * recorded. When that view renders empty — the rebase carried the reviewed
 * change cleanly — the file is not due in the round at all.
 */
export async function reviewRounds(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  diff: ChangeDiff,
): Promise<readonly ReviewRound[]> {
  const { base, tip } = diff;
  const rounds: {
    start: Revision;
    end: Revision;
    changed: ReadonlySet<FilePath>;
    files: Map<FilePath, FileView>;
  }[] = diff.spans.map(({ start, end, changed }) => ({ start, end, changed, files: new Map() }));
  const known = brain(entries, user);
  const tipKept = perTip((reviewedTip) => backend.isAncestor(reviewedTip, tip));
  const spansPast = perTip(
    async (reviewedTip) =>
      new Map((await remainingSpans(backend, diff.spans, reviewedTip)).map((span) => [span.end, span])),
  );
  // The files of the one span that resumes mid-span from the reviewed tip.
  const resumedFiles = perTip(async (reviewedTip) => {
    for (const { start, end } of (await spansPast(reviewedTip)).values()) {
      if (start === reviewedTip) {
        return new Set(await backend.changedFiles(start, end));
      }
    }
    // Only consulted for a remaining span whose start differs from its whole
    // span's, and such a span always starts at the reviewed tip.
    throw new Error(`no span resumes from reviewed tip ${reviewedTip}`);
  });
  const unseenFiles = perTip(async (reviewedTip) => new Set(await backend.changedFiles(reviewedTip, tip)));
  for (const file of [...new Set(rounds.flatMap(({ changed }) => [...changed]))].sort()) {
    const reviewed = known.get(file);
    if (reviewed !== undefined && reviewed.base === base && (await tipKept(reviewed.tip))) {
      // A review the history can place: what remains is the spans past the
      // reviewed tip, resuming mid-span when the tip falls inside one.
      const spans = await spansPast(reviewed.tip);
      for (const round of rounds) {
        const span = spans.get(round.end);
        if (span === undefined) {
          continue;
        }
        const changed = span.start === round.start ? round.changed : await resumedFiles(reviewed.tip);
        if (changed.has(file)) {
          round.files.set(file, { kind: "span", start: span.start });
        }
      }
      continue;
    }
    // A reviewed tip rewritten out of the change's history cannot be placed
    // among the first-parent spans, but what the user has not seen is exactly
    // the diff from its contents — nothing at all when the file comes out
    // unchanged.
    if (reviewed !== undefined && reviewed.base === base && !(await unseenFiles(reviewed.tip)).has(file)) {
      continue;
    }
    let first = true;
    for (const round of rounds) {
      if (!round.changed.has(file)) {
        continue;
      }
      const view: FileView =
        !first || reviewed === undefined
          ? { kind: "span", start: round.start }
          : reviewed.base !== base
            ? { kind: "rebased", reviewed }
            : { kind: "rewritten", from: reviewed.tip };
      first = false;
      if (view.kind !== "span" && (await carriedCleanly(backend, file, view, base, round.end))) {
        continue;
      }
      round.files.set(file, view);
    }
  }
  return rounds.filter(({ files }) => files.size > 0).map(({ end, files }) => ({ end, files }));
}

/**
 * Whether an unplaceable review leaves nothing to read up to `end`: the
 * rebase or rewrite carried the reviewed change cleanly, so `file`'s view
 * would render empty and the reviewer's recorded knowledge already covers
 * the round.
 */
async function carriedCleanly(
  backend: Backend,
  file: FilePath,
  view: Extract<FileView, { kind: "rebased" | "rewritten" }>,
  base: Revision,
  end: Revision,
): Promise<boolean> {
  let resolved: DiffView;
  if (view.kind === "rebased") {
    resolved = await rebasedView(backend, file, view.reviewed, base, end);
  } else {
    const [prev, next] = await Promise.all([backend.readFile(view.from, file), backend.readFile(end, file)]);
    resolved = { kind: "two", prev, next };
  }
  return diffViewEmpty(file, resolved);
}
