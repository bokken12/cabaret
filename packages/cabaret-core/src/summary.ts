import {
  type Backend,
  brain,
  type CommitHash,
  changeBase,
  currentForgeRequest,
  currentOwner,
  currentParent,
  type DiffSegment,
  type FilePath,
  type ForgeLocator,
  type ForgeRequestId,
  type LogEntry,
  landedMerge,
  type RefName,
  reviewSegments,
  type UserName,
} from "./backend.js";

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
    throw new Error(`parent links form a cycle among: ${cyclic.join(", ")}`);
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
  readonly forgeRequest: { readonly forge: ForgeLocator; readonly request: ForgeRequestId } | undefined;
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
  const base = await changeBase(backend, change, entries);
  // A landed change is frozen at the tip its land merge carries as its second
  // parent; the branch may since be gone or moved on. An unlanded change's
  // tip is its branch, pinned to the branch namespace so a same-named tag
  // cannot shadow it.
  const tip =
    landed !== undefined
      ? await backend.resolveCommit(`${landed}^2`)
      : await backend.resolveCommit(`refs/heads/${change}`);
  const reviewLeft = await filesLeft(backend, entries, user, base, tip);
  return {
    change,
    parent,
    owner: currentOwner(change, entries),
    forgeRequest: currentForgeRequest(entries),
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

/**
 * The files of the `base`..`tip` diff with review left for `user`, sorted by
 * name. A file needs review when it changes in a span of history the user has
 * not reviewed past. A review whose base is not the current base counts as
 * left outright: the base moved underneath it, and only `cabaret diff` can
 * tell whether anything genuinely remains.
 */
async function filesLeft(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  base: CommitHash,
  tip: CommitHash,
): Promise<readonly FilePath[]> {
  const changedIn = async (spans: readonly DiffSegment[]): Promise<ReadonlySet<FilePath>> => {
    const files = new Set<FilePath>();
    for (const { start, end } of spans) {
      for (const file of await backend.changedFiles(start, end)) {
        files.add(file);
      }
    }
    return files;
  };
  const known = brain(entries, user);
  // Reviews sharing a tip leave the same remaining spans; compute each once.
  const remaining = new Map<CommitHash, ReadonlySet<FilePath>>();
  const left: FilePath[] = [];
  for (const file of [...(await changedIn(await reviewSegments(backend, base, tip)))].sort()) {
    const reviewed = known.get(file);
    if (reviewed === undefined || reviewed.base !== base) {
      left.push(file);
      continue;
    }
    let unseen = remaining.get(reviewed.tip);
    if (unseen === undefined) {
      // A reviewed tip rewritten out of the change's history cannot be placed
      // among the first-parent segments; what the user has not seen is
      // exactly the diff from its contents.
      unseen = (await backend.isAncestor(reviewed.tip, tip))
        ? await changedIn(await reviewSegments(backend, base, tip, reviewed.tip))
        : await changedIn([{ start: reviewed.tip, end: tip }]);
      remaining.set(reviewed.tip, unseen);
    }
    if (unseen.has(file)) {
      left.push(file);
    }
  }
  return left;
}
