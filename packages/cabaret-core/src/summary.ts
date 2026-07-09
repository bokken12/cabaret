import {
  type Backend,
  brain,
  type CommitHash,
  changeBase,
  changeTip,
  currentForgeChange,
  currentOwner,
  currentParent,
  type FilePath,
  type ForgeChangeId,
  type ForgeLocator,
  type LogEntry,
  landedMerge,
  type RefName,
  type ReviewedDiff,
  reviewSegments,
  type UserName,
} from "./backend.js";
import { UserError } from "./error.js";

/** A change and the changes parented on it. */
export interface ChangeNode {
  readonly change: RefName;
  readonly children: readonly ChangeNode[];
}

/**
 * Arrange changes into a forest by their parent links. Roots are the changes
 * whose parent is not itself a change (typically a trunk branch like `main`);
 * roots and children sort by name. Parent links that form a cycle leave their
 * members reachable from no root, which is an error.
 */
export function changeForest(parents: ReadonlyMap<RefName, RefName>): readonly ChangeNode[] {
  const byParent = new Map<RefName, RefName[]>();
  for (const [change, parent] of parents) {
    const siblings = byParent.get(parent);
    if (siblings === undefined) {
      byParent.set(parent, [change]);
    } else {
      siblings.push(change);
    }
  }
  const reached = new Set<RefName>();
  const build = (change: RefName): ChangeNode => {
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
export type NextStep = "add code" | "review" | "rebase" | "land" | "landed";

/** A change's status at a glance, computed from its log for one user. */
export interface ChangeSummary {
  readonly change: RefName;
  readonly parent: RefName;
  readonly owner: UserName;
  readonly forgeChange: { readonly forge: ForgeLocator; readonly id: ForgeChangeId } | undefined;
  /** The merge that landed the change, or undefined if it has not landed. */
  readonly landed: CommitHash | undefined;
  readonly base: CommitHash;
  readonly tip: CommitHash;
  /** Files with review left for the user, sorted by name. */
  readonly reviewLeft: readonly FilePath[];
  readonly nextStep: NextStep;
}

/**
 * Summarize `change` for `user`. `entries` must be `change`'s log; taking it
 * explicitly lets callers batch one read of every log into both the parent
 * links `changeForest` wants and these summaries.
 */
export async function summarizeChange(
  backend: Backend,
  change: RefName,
  entries: readonly LogEntry[],
  user: UserName,
): Promise<ChangeSummary> {
  const parent = currentParent(change, entries);
  const landed = landedMerge(entries);
  const [base, tip] = await Promise.all([changeBase(backend, change, entries), changeTip(backend, change, entries)]);
  const rounds = await reviewRounds(backend, entries, user, base, tip);
  const reviewLeft = [...new Set(rounds.flatMap(({ files }) => [...files.keys()]))].sort();
  return {
    change,
    parent,
    owner: currentOwner(change, entries),
    forgeChange: currentForgeChange(entries),
    landed,
    base,
    tip,
    reviewLeft,
    nextStep: await nextStep(backend, parent, landed, base, tip, reviewLeft),
  };
}

async function nextStep(
  backend: Backend,
  parent: RefName,
  landed: CommitHash | undefined,
  base: CommitHash,
  tip: CommitHash,
  reviewLeft: readonly FilePath[],
): Promise<NextStep> {
  if (landed !== undefined) {
    return "landed";
  }
  if (tip === base) {
    return "add code";
  }
  if (reviewLeft.length > 0) {
    return "review";
  }
  // `land` refuses a change not based on its parent's tip, so a stale base
  // must rebase first.
  return (await backend.branchTip(parent)) === base ? "land" : "rebase";
}

/** What a reviewer looks at to review a file in a round. */
export type FileView =
  /** The plain diff from `start` to the round's end. */
  | { readonly kind: "span"; readonly start: CommitHash }
  /** The base moved under the review: compare the reviewed diff with the current one. */
  | { readonly kind: "rebased"; readonly reviewed: ReviewedDiff }
  /** The reviewed tip left the change's history: diff from its contents. */
  | { readonly kind: "rewritten"; readonly from: CommitHash };

/** One round of review: a span of a change's history with review left in it. */
export interface ReviewRound {
  /** The revision the round reviews up to: reviewing a file here records `{base, tip: end}`. */
  readonly end: CommitHash;
  /** What to review per file, sorted by name. */
  readonly files: ReadonlyMap<FilePath, FileView>;
}

/** Memoize an async derivation per reviewed tip: reviews sharing a tip share what remains. */
function perTip<T>(compute: (reviewedTip: CommitHash) => Promise<T>): (reviewedTip: CommitHash) => Promise<T> {
  const memo = new Map<CommitHash, T>();
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
 * The rounds of review left for `user` in `base`..`tip`, oldest first. Land
 * merges on the first-parent chain order review: everything before a land
 * merge is reviewed — and marked, at the round's end — before anything after
 * it, so a reviewer never reads code newer than a landing they have not
 * absorbed. A file is due in every round whose span it changes and that the
 * user has not reviewed past; a review the segments cannot place (its base
 * moved, or its tip was rewritten out of the history) puts the file's stale
 * knowledge in its earliest round's view, and later rounds assume the earlier
 * ones get recorded.
 */
export async function reviewRounds(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  base: CommitHash,
  tip: CommitHash,
): Promise<readonly ReviewRound[]> {
  const rounds: {
    start: CommitHash;
    end: CommitHash;
    changed: ReadonlySet<FilePath>;
    files: Map<FilePath, FileView>;
  }[] = [];
  for (const { start, end } of await reviewSegments(backend, base, tip)) {
    rounds.push({ start, end, changed: new Set(await backend.changedFiles(start, end)), files: new Map() });
  }
  const known = brain(entries, user);
  const tipKept = perTip((reviewedTip) => backend.isAncestor(reviewedTip, tip));
  const remainingSpans = perTip(
    async (reviewedTip) =>
      new Map((await reviewSegments(backend, base, tip, reviewedTip)).map((span) => [span.end, span])),
  );
  // The files of the one span that resumes mid-segment from the reviewed tip.
  const resumedFiles = perTip(async (reviewedTip) => {
    for (const { start, end } of (await remainingSpans(reviewedTip)).values()) {
      if (start === reviewedTip) {
        return new Set(await backend.changedFiles(start, end));
      }
    }
    // Only consulted for a span whose start differs from its segment's, and
    // such a span always starts at the reviewed tip.
    throw new Error(`no span resumes from reviewed tip ${reviewedTip}`);
  });
  const unseenFiles = perTip(async (reviewedTip) => new Set(await backend.changedFiles(reviewedTip, tip)));
  for (const file of [...new Set(rounds.flatMap(({ changed }) => [...changed]))].sort()) {
    const reviewed = known.get(file);
    if (reviewed !== undefined && reviewed.base === base && (await tipKept(reviewed.tip))) {
      // A review the history can place: what remains is the segments past the
      // reviewed tip, resuming mid-segment when the tip falls inside one.
      const spans = await remainingSpans(reviewed.tip);
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
    // among the first-parent segments, but what the user has not seen is
    // exactly the diff from its contents — nothing at all when the file comes
    // out unchanged.
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
      round.files.set(file, view);
      first = false;
    }
  }
  return rounds.filter(({ files }) => files.size > 0).map(({ end, files }) => ({ end, files }));
}
