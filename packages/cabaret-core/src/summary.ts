import {
  type Backend,
  brain,
  type ChangeDiff,
  type ChangedFile,
  type ChangeName,
  changeBase,
  changeConflicts,
  currentArchived,
  currentForgeChange,
  currentOwner,
  currentParent,
  currentPermanent,
  currentReviewers,
  currentReviewing,
  diffBetween,
  type FilePath,
  type FileSource,
  type ForgeChangeId,
  type ForgeLocator,
  finished,
  freshestReading,
  LAND_SCAN,
  type LandMerge,
  type LogEntry,
  landedMerge,
  landsAmong,
  observedForgeParent,
  type ReviewedDiff,
  type Reviewing,
  type Revision,
  requireTip,
  type UserName,
} from "./backend.js";
import { diffViewEmpty, rebasedView } from "./diff.js";
import { UserError } from "./error.js";
import { landBlockers, type ObligationsReading, obligationsReading, outstanding } from "./obligations.js";

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
  | "fix obligations"
  | "review"
  | "review in parent"
  | "add reviewers"
  | "widen reviewing"
  | "await review"
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
  /** The merge of the change's latest land, or undefined if it has never landed. */
  readonly landed: Revision | undefined;
  /** The changes landed into this one, oldest first. */
  readonly included: readonly LandMerge[];
  /** Whether the change is archived: set aside as not landing, reversibly. */
  readonly archived: boolean;
  /** Whether the change is permanent: structure expected to outlive its lands. */
  readonly permanent: boolean;
  readonly base: Revision;
  readonly tip: Revision;
  /** How the tip stands relative to origin's last-fetched copy, when they differ. */
  readonly origin: "ahead" | "behind" | "diverged" | undefined;
  /** What became of a parent that can no longer be built on. */
  readonly deadParent: "landed" | "missing" | "archived" | undefined;
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
  const frozen = finished(entries);
  const tracked = currentForgeChange(entries);
  const { base, tip } = diff;
  const left = reviewLeftFiles(await reviewLeft(backend, entries, user, diff));
  // A finished change is frozen, so nothing about its surroundings bears on
  // it. These are all local readings — origin's tip is whatever was last
  // fetched — so summarizing never makes a remote query.
  let origin: ChangeSummary["origin"];
  let staleParent: ChangeName | undefined;
  let deadParent: ChangeSummary["deadParent"];
  let parentOrigin: ChangeSummary["parentOrigin"];
  let stale: { readonly kind: NonNullable<ChangeSummary["staleBase"]>; readonly parentTip: Revision } | undefined;
  let parentReview: (() => Promise<ObligationsReading>) | undefined;
  if (!frozen) {
    if (tracked !== undefined) {
      const observed = observedForgeParent(entries, tracked.forge);
      if (observed !== undefined && observed !== parent) {
        staleParent = observed;
      }
    }
    origin = await originStanding(backend, change, tip);
    const parentEntries = await backend.readLog(parent);
    if (finished(parentEntries)) {
      deadParent = "landed";
    } else if (currentArchived(parentEntries)) {
      deadParent = "archived";
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
        // A trunk parent has no log to put obligations on, so only a change
        // parent reads. The diff is the one `land` would check.
        if (parentEntries.length > 0) {
          parentReview = async () =>
            obligationsReading(
              backend,
              parentEntries,
              currentOwner(parent, parentEntries),
              await diffBetween(backend, await changeBase(backend, parent, parentEntries), parentTip),
            );
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
    permanent: currentPermanent(entries),
    base,
    tip,
    origin,
    deadParent,
    parentOrigin,
    staleBase: stale?.kind,
    // A finished change is frozen; only live code is worth scanning for markers.
    conflicts: frozen ? [] : await changeConflicts(backend, diff),
    reviewLeft: left,
  };
  return { ...readings, nextStep: await nextStep(backend, readings, entries, user, diff, stale, parentReview) };
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
  const [origin, { merges, more }] = await Promise.all([
    originStanding(backend, change, tip),
    backend.chainMerges(undefined, tip, LAND_SCAN),
  ]);
  return { kind: "trunk", change, tip, origin, included: landsAmong(merges), truncated: more };
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
 * What must happen next, from the summary's other readings. An archived
 * change is set aside — done, when a land archived it, which reads as
 * `landed` — so it reads as its terminal step before anything else. An origin the
 * tip trails or diverged from outranks everything: each reading below is a
 * question about revisions this clone may lack, and either way syncing
 * mends it — the join absorbs origin's copy, committing any conflicts for
 * fixing. A change with no local
 * branch gates nothing: its readings are origin's copy already, and
 * operations that move the branch create it from that copy themselves. A
 * dead parent — landed, missing, or archived, all parents `land` refuses —
 * comes next: nothing can land until the change hangs somewhere live. Unresolved
 * conflicts outrank review: markers are not code worth reading. A malformed
 * obligations file outranks the review flow it would steer: `fix
 * obligations` is the owner's step, and no other reading asks anyone for
 * anything until the policy parses. A change
 * nobody is reviewing yet moves by widening; once the user's own review is
 * done, a reviewing set short of everyone widens next — after reviewers
 * exist to widen to. The whole flow asks only while some blocking obligation
 * is unsatisfied: once every one is met, the set gates nothing `land` reads,
 * so the change moves by landing however narrow the set stands — follow
 * review stays owed on the todo page, holding nothing here. Blockers the
 * flow has no ask left for — the set already reads everyone, the user's own
 * review done — read `await review`: the land waits on review only others
 * can give, and the step names the wait rather than a land that would
 * refuse. A
 * forge-tracked draft is the exception — the forge refuses to merge what
 * it shows as a draft — so it widens whatever the obligations say. Review
 * reads bottom-up — a child's diff builds on its parent's — so review the
 * user still owes the parent outranks reading the child. A stale
 * base waits for review to finish — the parent
 * moving on is routine, and rebasing mid-review churns reviewers — and
 * calls for a rebase only where `land` would refuse it: when the tip no
 * longer merges cleanly onto `stale`'s parent tip. That merge is dry-run
 * only when every earlier step is settled; a land that skips a step anyway
 * (`--even-though-unreviewed`) is still safe, since `prepareLand` makes its
 * own check. The dry-run, like the rebase and land it stands for, is a
 * question about the parent's tip — its freshest reading — so a parent
 * whose readings diverged outranks them: no freshest reading exists until
 * the user joins them. A parent with unsatisfied blocking obligations of its
 * own comes next, whoever owes them: `land` refuses to grow an unreviewed
 * parent, so the change reads `review in parent` until the parent is
 * fully reviewed. Last, a forge-tracked change syncs before landing when the
 * forge lags this clone — a tip ahead of origin, or a local reparent the
 * forge change's target has yet to follow — since the forge refuses to land
 * state it has not seen, while a local land reads nothing from origin and
 * lands as it stands.
 */
async function nextStep(
  backend: Backend,
  readings: Omit<ChangeSummary, "nextStep">,
  entries: readonly LogEntry[],
  user: UserName,
  diff: ChangeDiff,
  stale: { readonly parentTip: Revision } | undefined,
  parentReview: (() => Promise<ObligationsReading>) | undefined,
): Promise<NextStep> {
  if (readings.archived) {
    return readings.landed !== undefined ? "landed" : "archived";
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
  // Every reading below stands on the policy, so a policy nobody can parse
  // preempts them all: it reads as the owner's step to mend, and asks
  // review of nobody in the meantime.
  const reading = await obligationsReading(backend, entries, readings.owner, diff);
  if (reading.kind === "malformed") {
    return "fix obligations";
  }
  if (readings.reviewing === "none" && readings.forgeChange !== undefined) {
    return "widen reviewing";
  }
  const flow: NextStep | undefined =
    readings.reviewing === "none"
      ? "widen reviewing"
      : readings.reviewLeft.length > 0
        ? "review"
        : readings.reviewing === "owner" && readings.reviewers.length === 0
          ? "add reviewers"
          : readings.reviewing !== "everyone"
            ? "widen reviewing"
            : undefined;
  if (landBlockers(reading.statuses).length > 0) {
    if (flow === "review" && parentReview !== undefined && (await owesParentReview(parentReview, user))) {
      return "review in parent";
    }
    return flow ?? "await review";
  }
  if (readings.parentOrigin === "diverged") {
    return "resolve parent divergence";
  }
  if (stale !== undefined && (await backend.mergeConflicts(readings.base, readings.tip, stale.parentTip)).length > 0) {
    return "rebase";
  }
  if (parentReview !== undefined && parentBlocked(await parentReview())) {
    return "review in parent";
  }
  const { forgeChange } = readings;
  return forgeChange !== undefined && (readings.origin === "ahead" || forgeChange.staleParent !== undefined)
    ? "sync"
    : "land";
}

/**
 * Whether the parent's own obligations refuse the land: unsatisfied blockers,
 * or a policy nobody can parse — the parent's page says whose fix that is.
 */
function parentBlocked(reading: ObligationsReading): boolean {
  return reading.kind === "malformed" || landBlockers(reading.statuses).length > 0;
}

/**
 * Whether the parent still carries an unsatisfied blocking obligation `user`'s
 * review can count toward. A malformed parent policy claims nothing here — it
 * cannot say what anyone owes — so the user's own review proceeds.
 */
async function owesParentReview(parentReview: () => Promise<ObligationsReading>, user: UserName): Promise<boolean> {
  const reading = await parentReview();
  return reading.kind === "read" && landBlockers(reading.statuses).some((status) => outstanding(status).includes(user));
}

/**
 * The files `left` still owes, one entry per path, in `left`'s order. A file
 * whose view moves or copies it names its source — the first thing its
 * reviewer will read.
 */
export function reviewLeftFiles(left: ReviewLeft): readonly ChangedFile[] {
  return [...left].map(([path, view]) => ({ path, source: view.kind === "fresh" ? view.source : undefined }));
}

/** What a reviewer looks at to review a file. */
export type FileView =
  /** No prior review: the plain diff, base to tip — from the file's `source` path when the diff moves or copies it. */
  | { readonly kind: "fresh"; readonly source: FileSource | undefined }
  /** Reviewed at this base: the diff onward from the reviewed tip. */
  | { readonly kind: "extend"; readonly from: Revision }
  /** The base moved under the review: compare the reviewed diff with the current one. */
  | { readonly kind: "rebased"; readonly reviewed: ReviewedDiff };

/** The review of a change left for one user: what to look at per file, sorted by name. */
export type ReviewLeft = ReadonlyMap<FilePath, FileView>;

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
 * The review of `diff` left for `user`: per changed file, what to look at —
 * absent when their latest review of the file covers its current diff. A
 * file never reviewed shows the whole diff; one reviewed at the current base
 * shows the diff onward from the reviewed tip; one whose base moved under
 * the review compares the reviewed diff with the current one, and an empty
 * comparison — the rebase carried the reviewed change cleanly — discharges
 * the review silently.
 *
 * The records alone answer: a land needs no reading here, because landing
 * writes the review it settles (as `recordLand`) — the diff a land brings in
 * was reviewed under the landed change's log, or joins this change's
 * catch-up, and either way the entries written at the land say so.
 */
export async function reviewLeft(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  diff: ChangeDiff,
): Promise<ReviewLeft> {
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
  // The files changed since a reviewed tip, batched per tip: one reading
  // answers "is the diff onward from here empty" for every file at once.
  const changedSince = perRevision(
    async (from) => new Set(from === tip ? [] : (await backend.changedFiles(from, tip)).map(({ path }) => path)),
  );
  const left = new Map<FilePath, FileView>();
  for (const [file, { source }] of [...diff.changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const reviewed = known.get(file);
    if (reviewed === undefined) {
      left.set(file, { kind: "fresh", source });
    } else if (reviewed.base === base) {
      if ((await changedSince(reviewed.tip)).has(file)) {
        left.set(file, { kind: "extend", from: reviewed.tip });
      }
    } else if (!diffViewEmpty(file, await rebasedView(backend, file, reviewed, base, tip))) {
      left.set(file, { kind: "rebased", reviewed });
    }
  }
  return left;
}
