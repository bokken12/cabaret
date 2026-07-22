import {
  allChanges,
  type Backend,
  type Change,
  type ChangeName,
  type ChangeNode,
  type ChangeSummary,
  changeDiff,
  changeForest,
  currentArchived,
  currentName,
  currentParent,
  type FilePath,
  isReviewing,
  isSelf,
  resolveNamed,
  reviewOwed,
  type Self,
  selfAs,
  summarizeChange,
  type TimestampMs,
  UserError,
  type UserName,
} from "cabaret-core";
import { mapConcurrent } from "cabaret-util";
import { type Doc, type Line, layout, type Node, section, span } from "./doc.js";
import { fetchedFooter } from "./fetched.js";
import { stepSpan, stepStyle } from "./steps.js";
import { type Cell, type Column, tableParts } from "./table.js";
import { dirtyNote, type WorkspaceNote, workspaceNotes } from "./workspaces.js";

/** A change to act on and the changes stacked on it. */
export interface OwnedNode {
  readonly summary: ChangeSummary;
  /** Kept only so its descendants hang somewhere; hosts dim it. */
  readonly context: boolean;
  readonly children: readonly OwnedNode[];
}

/** A change in the review forest and the changes stacked on it. */
export interface ReviewNode {
  readonly summary: ChangeSummary;
  /** Files still awaiting the user; empty on an ancestor kept only for context. */
  readonly owed: readonly FilePath[];
  readonly children: readonly ReviewNode[];
}

/** A change the page could not read, and what went wrong. */
export interface BrokenChange {
  readonly change: ChangeName;
  readonly message: string;
}

/** What awaits one user's attention, each section a forest along parent links. */
export interface HomePage {
  /** Whose home this is when not the current user's own, as `selfAs` resolves it. */
  readonly as: UserName | undefined;
  /**
   * Changes with an unsatisfied obligation the user's review can still
   * count toward. A change nobody asked the user to review stays off the
   * page, however much of it they have not read, except as an ancestor
   * kept so an owed descendant reads in place.
   */
  readonly review: readonly ReviewNode[];
  /**
   * The user's live changes. A change that is archived or someone else's
   * stays only while kept children hang from it.
   */
  readonly owned: readonly OwnedNode[];
  /**
   * Changes whose state could not be read (say, a log whose branch is gone),
   * sorted by name. They are left out of the sections rather than blocking
   * the page, since this page is where every other change gets triaged.
   */
  readonly broken: readonly BrokenChange[];
  /**
   * The names checked out in workspaces on this device, each change situated
   * in its stack: ancestors without workspaces of their own ride along for
   * context. Checked-out names no change log speaks for — a trunk like main —
   * lead flat, in workspace order (the primary working tree first). This is
   * where a workspace whose change has landed gets noticed — and reclaimed.
   */
  readonly workspaces: readonly WorkspaceNode[];
  /** When this clone last fetched from origin, when known. */
  readonly fetched: TimestampMs | undefined;
}

/** A change in the workspace forest: checked out on this device, or an ancestor kept to situate one. */
export interface WorkspaceNode {
  readonly change: ChangeName;
  /** The workspace holding the change; absent on an ancestor kept only for context. */
  readonly held: HeldWorkspace | undefined;
  readonly children: readonly WorkspaceNode[];
}

/** A workspace and what its change's log says of its usefulness. */
export interface HeldWorkspace {
  readonly workspace: WorkspaceNote;
  /** Whether the change finished — landed and archived — leaving the workspace ready to remove. */
  readonly landed: boolean;
  /** Whether the change is archived without landing, likewise leaving the workspace idle. */
  readonly archived: boolean;
}

/** Changes read at once: each reading costs several git processes. */
const READ_CONCURRENCY = 8;

/** One change's readings for the page, or what broke reading them. */
type ChangeReading =
  | {
      readonly kind: "read";
      readonly summary: ChangeSummary;
      readonly parent: ChangeName;
      readonly owed: readonly FilePath[];
    }
  | { readonly kind: "broken"; readonly message: string };

async function readChange(
  backend: Backend,
  self: Self,
  change: Change,
  all: readonly Change[],
): Promise<ChangeReading> {
  const entries = change.entries;
  const name = currentName(change.id, entries);
  const diff = await changeDiff(backend, name, entries);
  const summary = await summarizeChange(backend, change, self.user, diff, all);
  // Obligations ask nothing of a user outside the reviewing set — a
  // membership the log alone decides, sparing the obligations files of
  // most changes. An empty reviewLeft already counts the user toward
  // every obligation — though it says nothing about their aliases, whose
  // obligations each count that identity's own reviews. A change with
  // conflict markers asks review of nobody: fixing them rewrites the
  // tip, so reading it now is wasted. A landed change still asks, archived
  // with the land or not: the follow review its landing left in place
  // stays owed until reviewers catch up.
  const asked =
    (!summary.archived || summary.landed !== undefined) &&
    summary.conflicts.length === 0 &&
    (summary.reviewLeft.length > 0 || self.aliases.size > 0) &&
    isReviewing(self, name, entries);
  return {
    kind: "read",
    summary,
    parent: currentParent(name, entries),
    owed: asked ? await reviewOwed(backend, entries, summary.owner, self, diff) : [],
  };
}

export async function homePage(backend: Backend, as?: UserName): Promise<HomePage> {
  const acting = await selfAs(backend, as);
  const self = acting.self;
  const workspaces = await workspaceNotes(backend);
  const all = await allChanges(backend);
  const changes = [...all].sort((a, b) => {
    const aName = currentName(a.id, a.entries);
    const bName = currentName(b.id, b.entries);
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
  // Each change reads independently; assembling in `changes` order afterwards
  // keeps the page deterministic whatever order the readings finish in.
  const readings = await mapConcurrent(changes, READ_CONCURRENCY, async (change): Promise<ChangeReading> => {
    try {
      return await readChange(backend, self, change, all);
    } catch (error) {
      // Only state problems isolate to their change; a bug still throws.
      if (!(error instanceof UserError)) {
        throw error;
      }
      return { kind: "broken", message: error.message };
    }
  });
  const summaries = new Map<ChangeName, ChangeSummary>();
  const parents = new Map<ChangeName, ChangeName>();
  const owedFiles = new Map<ChangeName, readonly FilePath[]>();
  const broken: BrokenChange[] = [];
  // The page's maps are name-keyed, so a name claimed twice renders as its
  // arbitration winner — never hiding a live change behind an archived
  // twin — and the loser files as a broken row rather than vanishing. A
  // live tie renders the roster's first instead of failing the page.
  const canonicalOf = (name: ChangeName): Change | undefined => {
    try {
      return resolveNamed(changes, name);
    } catch {
      return changes.find(
        (change) => currentName(change.id, change.entries) === name && !currentArchived(change.entries),
      );
    }
  };
  changes.forEach((change, index) => {
    const reading = readings[index];
    if (reading === undefined) {
      throw new Error(`change read no reading: ${change.id}`);
    }
    const name = currentName(change.id, change.entries);
    if (reading.kind === "broken") {
      broken.push({ change: name, message: reading.message });
      return;
    }
    const winner = canonicalOf(name);
    if (winner !== undefined && winner.id !== change.id) {
      broken.push({ change: name, message: "hidden behind another change with the same name" });
      return;
    }
    summaries.set(name, reading.summary);
    parents.set(name, reading.parent);
    if (reading.owed.length > 0) {
      owedFiles.set(name, reading.owed);
    }
  });
  const summary = (change: ChangeName): ChangeSummary => {
    const found = summaries.get(change);
    if (found === undefined) {
      throw new Error(`change vanished while summarizing: ${change}`);
    }
    return found;
  };
  const pruneOwned = (nodes: readonly ChangeNode[]): OwnedNode[] =>
    nodes.flatMap((node) => {
      const candidate = summary(node.change);
      const children = pruneOwned(node.children);
      const mine = !candidate.archived && isSelf(self, candidate.owner);
      return mine || children.length > 0 ? [{ summary: candidate, context: !mine, children }] : [];
    });
  const pruneReview = (nodes: readonly ChangeNode[]): ReviewNode[] =>
    nodes.flatMap((node) => {
      const children = pruneReview(node.children);
      const owed = owedFiles.get(node.change) ?? [];
      return owed.length > 0 || children.length > 0 ? [{ summary: summary(node.change), owed, children }] : [];
    });
  const forest = changeForest(parents);
  const pruneWorkspaces = (nodes: readonly ChangeNode[]): WorkspaceNode[] =>
    nodes.flatMap((node) => {
      const children = pruneWorkspaces(node.children);
      const workspace = workspaces.get(node.change);
      const candidate = summary(node.change);
      const finished = candidate.landed !== undefined && candidate.archived;
      const held =
        workspace === undefined
          ? undefined
          : { workspace, landed: finished, archived: candidate.archived && !finished };
      return held !== undefined || children.length > 0 ? [{ change: node.change, held, children }] : [];
    });
  // A workspace on a branch that is no change still shows — its name still
  // opens a page — flat, with the log-borne notes blank.
  const loose = [...workspaces].flatMap(([change, workspace]): WorkspaceNode[] =>
    summaries.has(change) ? [] : [{ change, held: { workspace, landed: false, archived: false }, children: [] }],
  );
  return {
    as: acting.as,
    review: pruneReview(forest),
    owned: pruneOwned(forest),
    broken,
    workspaces: [...loose, ...pruneWorkspaces(forest)],
    fetched: await backend.originFetched(),
  };
}

/** Flatten a forest depth-first, pairing each node with its tree guide. */
function treeRows<N extends { readonly children: readonly N[] }>(
  forest: readonly N[],
): readonly { readonly node: N; readonly guide: string }[] {
  const rows: { node: N; guide: string }[] = [];
  const walk = (nodes: readonly N[], prefix: string, top: boolean): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      rows.push({ node, guide: top ? "" : `${prefix}${last ? "└─ " : "├─ "}` });
      walk(node.children, top ? "" : `${prefix}${last ? "   " : "│  "}`, false);
    });
  };
  walk(forest, "", true);
  return rows;
}

/**
 * A cell naming `summary`'s change. The tree guide rides alongside untargeted,
 * keeping the link on exactly the name.
 */
function changeCell(summary: ChangeSummary, guide: string, as: UserName | undefined, style?: "context"): Cell {
  // The name wears its change's status paint; the guide is structure, like
  // the table chrome, so only context's whole-row dimming reaches it.
  const name = span(summary.change, {
    style: style ?? stepStyle(summary.nextStep),
    target: { kind: "change", change: summary.change, as },
  });
  return guide === "" ? name : [span(guide, { style }), name];
}

/**
 * Regroup a forest's depth-first row lines into a node per tree, each subtree
 * a section folding its descendants under the root's own row.
 */
function treeNodes<N extends { readonly children: readonly N[] }>(forest: readonly N[], rows: readonly Line[]): Node[] {
  let next = 0;
  const walk = (nodes: readonly N[]): Node[] =>
    nodes.map((node) => {
      const row = rows[next];
      if (row === undefined) {
        throw new Error("fewer rows than forest nodes");
      }
      next += 1;
      return node.children.length === 0 ? row : section(row, walk(node.children));
    });
  const built = walk(forest);
  if (next !== rows.length) {
    throw new Error("more rows than forest nodes");
  }
  return built;
}

/** The forest laid out as a titled, foldable table with a section per subtree. */
function forestSection<N extends { readonly children: readonly N[] }>(
  title: string,
  forest: readonly N[],
  columns: readonly Column[],
  cells: readonly (readonly Cell[])[],
): Node {
  const { head, rows, foot } = tableParts(columns, cells);
  return section({ spans: [span(title, { style: "heading" })] }, [...head, ...treeNodes(forest, rows), foot]);
}

/**
 * The workspaces section: a row per change checked out on this device, in its
 * stack. An ancestor kept only to situate dims; a landed or archived note
 * wears nudge paint, inviting the workspace's reclaiming.
 */
function workspacesSection(forest: readonly WorkspaceNode[], as: UserName | undefined, now: TimestampMs): Node {
  const rows = treeRows(forest).map(({ node: { change, held }, guide }): readonly Cell[] => {
    const style = held === undefined ? "context" : undefined;
    const name = span(change, { style, target: { kind: "change", change, as } });
    const notes =
      held === undefined
        ? []
        : [
            ...(held.workspace.dirty === undefined ? [] : [dirtyNote(held.workspace.dirty, now)]),
            ...(held.landed ? ["landed"] : []),
            ...(held.archived ? ["archived"] : []),
          ];
    return [
      guide === "" ? name : [span(guide, { style }), name],
      span(notes.join(", "), { style: held !== undefined && (held.landed || held.archived) ? "nudge" : undefined }),
    ];
  });
  return forestSection(
    "Workspaces on this device:",
    forest,
    [
      { header: "change", align: "left" },
      { header: "note", align: "left" },
    ],
    rows,
  );
}

export function homeDoc(page: HomePage, now: TimestampMs): Doc {
  const reviewRows = treeRows(page.review).map(({ node: { summary, owed }, guide }): readonly Cell[] => {
    const style = owed.length === 0 ? "context" : undefined;
    return [changeCell(summary, guide, page.as, style), span(owed.length === 0 ? "" : String(owed.length))];
  });
  const ownedRows = treeRows(page.owned).map(({ node: { summary, context }, guide }): readonly Cell[] => {
    const style = context ? "context" : undefined;
    return [changeCell(summary, guide, page.as, style), stepSpan(summary, page.as, style)];
  });
  const title = page.as === undefined ? "Home" : `Home as ${page.as}`;
  return layout(
    [
      { spans: [span(title, { style: "heading" })] },
      { spans: [span("=".repeat(title.length))] },
      { spans: [] },
      forestSection(
        "Changes to review:",
        page.review,
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
        ],
        reviewRows,
      ),
      { spans: [] },
      forestSection(
        "Changes you own:",
        page.owned,
        [
          { header: "change", align: "left" },
          { header: "next step", align: "left" },
        ],
        ownedRows,
      ),
      // Unlike the sections above, absence needs no showing: no row is not a
      // gap to fill but simply no change checked out on this device.
      ...(page.workspaces.length === 0 ? [] : [{ spans: [] }, workspacesSection(page.workspaces, page.as, now)]),
      ...fetchedFooter(page.fetched),
    ],
    page.broken.map(({ change, message }) => `${change}: ${message}`),
  );
}
