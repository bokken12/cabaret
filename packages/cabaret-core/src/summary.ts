import {
  type Backend,
  brain,
  type ChangeDiff,
  type ChangedFile,
  type ChangeName,
  changeConflicts,
  currentArchived,
  currentForgeChange,
  currentOwner,
  currentParent,
  currentReviewers,
  currentReviewing,
  type FilePath,
  type FileSource,
  type ForgeChangeId,
  type ForgeLocator,
  freshestReading,
  LAND_SCAN,
  type LandMerge,
  type LogEntry,
  landedMerge,
  observedForgeParent,
  type ReviewedDiff,
  type Reviewing,
  type Revision,
  requireTip,
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
  | "sync"
  | "reparent"
  | "fix conflicts"
  | "add code"
  | "review"
  | "add reviewers"
  | "widen reviewing"
  | "resolve parent divergence"
  | "rebase"
  | "land"
  | "landed"
  | "archived";

/** A change's status at a glance, computed from its log for one user. */
export interface ChangeSummary {
  readonly kind: "change";
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
  /** Set when the parent's local tip and origin's last-fetched copy have diverged: the user's to join. */
  readonly parentOrigin: "diverged" | undefined;
  /** How the base stands relative to a live parent's tip, when they differ. */
  readonly staleBase: "behind" | "diverged" | undefined;
  /** Files whose contents at the tip still carry conflict markers, sorted by name. */
  readonly conflicts: readonly FilePath[];
  /** Files with review left for the user, sorted by name; a moved or copied file names its source. */
  readonly reviewLeft: readonly ChangedFile[];
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
  const reviewLeft = reviewLeftFiles(await reviewRound(backend, entries, user, diff));
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
    origin = await originStanding(backend, change, tip);
    if (landedMerge(await backend.readLog(parent)) !== undefined) {
      deadParent = "landed";
    } else {
      const reading = await freshestReading(backend, parent);
      if (reading.kind === "none") {
        deadParent = "missing";
      } else {
        let parentTip: Revision;
        if (reading.kind === "diverged") {
          parentOrigin = "diverged";
          // Arbitrating diverged readings is the user's; meanwhile the local
          // one is the position they have declared.
          parentTip = reading.local;
        } else {
          parentTip = reading.tip;
        }
        if (parentTip !== base) {
          stale = { kind: (await backend.isAncestor(base, parentTip)) ? "behind" : "diverged", parentTip };
        }
      }
    }
  }
  const readings = {
    kind: "change" as const,
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
 * How `tip` stands relative to origin's last-fetched copy of `change`, when
 * they differ. A change with no local branch reads as origin's copy itself —
 * trivially in sync, so no reading arises, just as when a local branch
 * matches.
 */
async function originStanding(backend: Backend, change: ChangeName, tip: Revision): Promise<ChangeSummary["origin"]> {
  const originTip = await backend.originTip(change);
  if (originTip === undefined || originTip === tip) {
    return undefined;
  }
  return (await backend.isAncestor(originTip, tip))
    ? "ahead"
    : (await backend.isAncestor(tip, originTip))
      ? "behind"
      : "diverged";
}

/**
 * A branch with no log, read as a change: a trunk like `main`, or any branch
 * Cabaret never created. Nothing was ever declared about it — no owner, no
 * parent, no base — so its status is only what its history shows.
 */
export interface TrunkSummary {
  readonly kind: "trunk";
  readonly change: ChangeName;
  readonly tip: Revision;
  /** How the tip stands relative to origin's last-fetched copy, when they differ. */
  readonly origin: "ahead" | "behind" | "diverged" | undefined;
  /** The changes landed into the branch recently, oldest first. */
  readonly included: readonly LandMerge[];
  /** Whether the history continues past the bounded scan behind `included`. */
  readonly truncated: boolean;
}

/** Summarize a branch with no log. */
export async function summarizeTrunk(backend: Backend, change: ChangeName): Promise<TrunkSummary> {
  const tip = await requireTip(backend, change);
  const [origin, { lands, more }] = await Promise.all([
    originStanding(backend, change, tip),
    backend.landMerges(undefined, tip, LAND_SCAN),
  ]);
  return { kind: "trunk", change, tip, origin, included: lands, truncated: more };
}

/**
 * The names the logs speak for: every change, and every trunk — a parent
 * changes hang from without it being a change itself, which is how a default
 * branch is acknowledged without a log of its own. These are the names to
 * offer and to answer for implicitly; a branch no log refers to shows only
 * when named outright.
 */
export async function knownChanges(backend: Backend): Promise<readonly ChangeName[]> {
  const changes = await backend.listChanges();
  const names = new Set<ChangeName>(changes);
  for (const change of changes) {
    names.add(currentParent(change, await backend.readLog(change)));
  }
  return [...names].sort();
}

/**
 * What must happen next, from the summary's other readings. A landed change
 * is done and an archived one is set aside, so both read as their terminal
 * step before anything else. An origin the
 * tip trails or diverged from outranks everything: each reading below is a
 * question about revisions this clone may lack, and either way syncing
 * mends it — the join absorbs origin's copy, committing any conflicts for
 * fixing. A change with no local
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
 * question about the parent's tip — its freshest reading — so a parent
 * whose readings diverged outranks them: no freshest reading exists until
 * the user joins them. Last, a forge-tracked change syncs before landing when the
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
  if (readings.origin === "behind" || readings.origin === "diverged") {
    return "sync";
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
  if (readings.parentOrigin === "diverged") {
    return "resolve parent divergence";
  }
  if (stale !== undefined && (await backend.mergeConflicts(readings.base, readings.tip, stale.parentTip)).length > 0) {
    return "rebase";
  }
  const { forgeChange } = readings;
  return forgeChange !== undefined && (readings.origin === "ahead" || forgeChange.staleParent !== undefined)
    ? "sync"
    : "land";
}

/**
 * The files `round` still owes, one entry per path, sorted by name. A file
 * whose pending view moves or copies it names its source — that view is the
 * first thing its reviewer will read.
 */
export function reviewLeftFiles(round: ReviewRound | undefined): readonly ChangedFile[] {
  const left: ChangedFile[] = [];
  for (const [path, view] of round?.files ?? []) {
    left.push({ path, source: view.kind === "span" ? view.source : undefined });
  }
  return left.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What a reviewer looks at to review a file in a round. */
export type FileView =
  /** The plain diff from `start` to the round's end — from the file's `source` path when the span moves or copies it. */
  | { readonly kind: "span"; readonly start: Revision; readonly source: FileSource | undefined }
  /** The base moved under the review: compare the reviewed diff with the current one. */
  | { readonly kind: "rebased"; readonly reviewed: ReviewedDiff }
  /** The reviewed tip left the change's history: diff from its contents. */
  | { readonly kind: "rewritten"; readonly from: Revision };

/** The round of review left: the change as it currently stands. */
export interface ReviewRound {
  /** The revision the round reviews up to — the tip: reviewing a file here records `{base, tip: end}`. */
  readonly end: Revision;
  /** What to review per file, sorted by name. */
  readonly files: ReadonlyMap<FilePath, FileView>;
}

/** Memoize an async derivation per revision: reviews sharing a revision share the answer. */
function perRevision<T>(compute: (revision: Revision) => Promise<T>): (revision: Revision) => Promise<T> {
  const memo = new Map<Revision, T>();
  return async (revision) => {
    let value = memo.get(revision);
    if (value === undefined) {
      value = await compute(revision);
      memo.set(revision, value);
    }
    return value;
  };
}

/**
 * The round of review left for `user` in `diff`, or undefined with none.
 * Each changed file is judged by the latest review that speaks for it — the
 * user's own record, or the implicit review of the land merge that brought
 * the file in, whichever reaches further — against the current diff. A
 * review at the current base leaves the plain diff past its tip; one whose
 * base has moved leaves the 4-way comparison of the reviewed diff with the
 * current one, and nothing at all when that comparison renders empty — the
 * change carried cleanly over whatever moved.
 */
export async function reviewRound(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  diff: ChangeDiff,
): Promise<ReviewRound | undefined> {
  const { base, tip } = diff;
  // A review recorded against objects this clone lacks — reviewed where the
  // commits were never pushed — can be neither placed in the history nor
  // diffed from, so the file counts as unreviewed.
  const held = perRevision((revision) => backend.hasRevision(revision));
  const known = new Map(brain(entries, user));
  for (const [file, reviewed] of known) {
    if (!((await held(reviewed.base)) && (await held(reviewed.tip)))) {
      known.delete(file);
    }
  }
  const tipKept = perRevision((reviewedTip) => backend.isAncestor(reviewedTip, tip));
  const unseenFiles = perRevision(
    async (reviewedTip) => new Set((await backend.changedFiles(reviewedTip, tip)).map(({ path }) => path)),
  );
  const files = new Map<FilePath, FileView>();
  for (const file of [...diff.changed.keys()].sort()) {
    const entry = diff.changed.get(file);
    if (entry === undefined) {
      throw new Error(`diff lost track of ${JSON.stringify(file)}`);
    }
    const reviewed = await freshestReview(backend, file, known.get(file), diff.landed.get(file));
    let view: FileView;
    if (reviewed === undefined) {
      view = { kind: "span", start: base, source: entry.source };
    } else if (reviewed.base === base) {
      if (!(await unseenFiles(reviewed.tip)).has(file)) {
        continue;
      }
      view = (await tipKept(reviewed.tip))
        ? { kind: "span", start: reviewed.tip, source: entry.source }
        : { kind: "rewritten", from: reviewed.tip };
    } else {
      view = { kind: "rebased", reviewed };
    }
    if (view.kind !== "span" && (await carriedCleanly(backend, file, view, base, tip))) {
      continue;
    }
    files.set(file, view);
  }
  return files.size > 0 ? { end: tip, files } : undefined;
}

/**
 * The review that reaches furthest for `file`: the user's own record, or the
 * land's implicit review. The land wins when the record predates it and owed
 * nothing between its tip and the landed window's start — the usual shapes
 * being no record at all, or one from before the land. A record the land
 * cannot be compared against (its tip rewritten out of the history) stands
 * on its own: at worst the user re-reads landed content, never skips.
 */
async function freshestReview(
  backend: Backend,
  file: FilePath,
  own: ReviewedDiff | undefined,
  landed: ReviewedDiff | undefined,
): Promise<ReviewedDiff | undefined> {
  if (own === undefined || landed === undefined) {
    return own ?? landed;
  }
  if (!(await backend.isAncestor(own.tip, landed.tip))) {
    return own;
  }
  const gap = await backend.changedFiles(own.tip, landed.base);
  return gap.some(({ path }) => path === file) ? own : landed;
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
