import {
  type Backend,
  type ChangeName,
  type ChangeNode,
  type ChangeSummary,
  changeDiff,
  changeForest,
  currentArchived,
  currentOwner,
  currentParent,
  type FilePath,
  isReviewing,
  isSelf,
  landedMerge,
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
import { type WorkspaceNote, workspaceNotes } from "./workspaces.js";

/** A change to act on and the changes stacked on it. */
export type OwnedNode =
  | {
      readonly kind: "owned";
      readonly summary: ChangeSummary;
      readonly children: readonly OwnedNode[];
    }
  | {
      /** Kept only so its descendants hang somewhere; hosts dim it. */
      readonly kind: "context";
      readonly change: ChangeName;
      /** What the log says became of the change, when it is done. */
      readonly step: "landed" | "archived" | undefined;
      readonly children: readonly OwnedNode[];
    };

/** A change in the review forest and the changes stacked on it. */
export type ReviewNode =
  | {
      readonly kind: "owed";
      readonly summary: ChangeSummary;
      /** Files still awaiting the user; never empty. */
      readonly owed: readonly FilePath[];
      readonly children: readonly ReviewNode[];
    }
  | {
      /** An ancestor kept only so an owed descendant reads in place; hosts dim it. */
      readonly kind: "context";
      readonly change: ChangeName;
      readonly children: readonly ReviewNode[];
    };

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
   * Unlanded changes with an unsatisfied obligation the user's review can
   * still count toward. A change nobody asked the user to review stays off
   * the page, however much of it they have not read, except as an ancestor
   * kept so an owed descendant reads in place.
   */
  readonly review: readonly ReviewNode[];
  /**
   * The user's unlanded changes. A change that is landed or someone else's
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
  /** Whether the change has landed, leaving the workspace ready to remove. */
  readonly landed: boolean;
  /** Whether the change is archived, likewise leaving the workspace idle. */
  readonly archived: boolean;
}

/** Changes read at once: each reading costs several git processes. */
const READ_CONCURRENCY = 8;

/**
 * What a change's log alone answers: enough to place the change in the
 * forests and to see whether anything on this page could need its code.
 */
interface Glance {
  readonly parent: ChangeName;
  readonly owner: UserName;
  readonly landed: boolean;
  readonly archived: boolean;
}

/** One change's readings for the page, or what broke reading them. */
type ChangeReading =
  | {
      readonly kind: "full";
      readonly glance: Glance;
      readonly summary: ChangeSummary;
      readonly owed: readonly FilePath[];
    }
  | { readonly kind: "glanced"; readonly glance: Glance }
  | { readonly kind: "broken"; readonly message: string };

async function readChange(backend: Backend, self: Self, change: ChangeName): Promise<ChangeReading> {
  const entries = await backend.readLog(change);
  const glance: Glance = {
    parent: currentParent(change, entries),
    owner: currentOwner(change, entries),
    landed: landedMerge(entries) !== undefined,
    archived: currentArchived(entries),
  };
  // The log alone decides whose attention a change could hold: obligations
  // ask nothing of a user outside the reviewing set, an archived change
  // asks nobody, and the owned section wants only the user's own live
  // changes. Everything else — most changes, in a large organization —
  // stops here, its diff and obligations never read. A landed change can
  // still ask: the follow review its landing left in place stays owed
  // until reviewers catch up.
  const owned = !glance.landed && !glance.archived && isSelf(self, glance.owner);
  const reviewing = !glance.archived && isReviewing(self, change, entries);
  if (!owned && !reviewing) {
    return { kind: "glanced", glance };
  }
  const diff = await changeDiff(backend, change, entries);
  const summary = await summarizeChange(backend, change, entries, self.user, diff);
  // An empty reviewLeft already counts the user toward every obligation —
  // though it says nothing about their aliases, whose obligations each
  // count that identity's own reviews. A change with conflict markers asks
  // review of nobody: fixing them rewrites the tip, so reading it now is
  // wasted.
  const asked = reviewing && summary.conflicts.length === 0 && (summary.reviewLeft.length > 0 || self.aliases.size > 0);
  return {
    kind: "full",
    glance,
    summary,
    owed: asked ? await reviewOwed(backend, entries, summary.owner, self, diff) : [],
  };
}

export async function homePage(backend: Backend, as?: UserName): Promise<HomePage> {
  const acting = await selfAs(backend, as);
  const self = acting.self;
  const workspaces = await workspaceNotes(backend);
  const changes = [...(await backend.listChanges())].sort();
  // Each change reads independently; assembling in `changes` order afterwards
  // keeps the page deterministic whatever order the readings finish in.
  const readings = await mapConcurrent(changes, READ_CONCURRENCY, async (change): Promise<ChangeReading> => {
    try {
      return await readChange(backend, self, change);
    } catch (error) {
      // Only state problems isolate to their change; a bug still throws.
      if (!(error instanceof UserError)) {
        throw error;
      }
      return { kind: "broken", message: error.message };
    }
  });
  const glances = new Map<ChangeName, Glance>();
  const fulls = new Map<ChangeName, { readonly summary: ChangeSummary; readonly owed: readonly FilePath[] }>();
  const broken: BrokenChange[] = [];
  changes.forEach((change, index) => {
    const reading = readings[index];
    if (reading === undefined) {
      throw new Error(`change read no reading: ${change}`);
    }
    if (reading.kind === "broken") {
      broken.push({ change, message: reading.message });
      return;
    }
    glances.set(change, reading.glance);
    if (reading.kind === "full") {
      fulls.set(change, { summary: reading.summary, owed: reading.owed });
    }
  });
  const glance = (change: ChangeName): Glance => {
    const found = glances.get(change);
    if (found === undefined) {
      throw new Error(`change vanished while glancing: ${change}`);
    }
    return found;
  };
  const pruneOwned = (nodes: readonly ChangeNode[]): OwnedNode[] =>
    nodes.flatMap((node): readonly OwnedNode[] => {
      const children = pruneOwned(node.children);
      const { landed, archived, owner } = glance(node.change);
      const mine = !landed && !archived && isSelf(self, owner);
      if (mine) {
        // The same reading readChange calls owned, so the full read always ran.
        const summary = fulls.get(node.change)?.summary;
        if (summary === undefined) {
          throw new Error(`owned change read no summary: ${node.change}`);
        }
        return [{ kind: "owned", summary, children }];
      }
      return children.length > 0
        ? [
            {
              kind: "context",
              change: node.change,
              step: landed ? "landed" : archived ? "archived" : undefined,
              children,
            },
          ]
        : [];
    });
  const pruneReview = (nodes: readonly ChangeNode[]): ReviewNode[] =>
    nodes.flatMap((node): readonly ReviewNode[] => {
      const children = pruneReview(node.children);
      const full = fulls.get(node.change);
      if (full !== undefined && full.owed.length > 0) {
        return [{ kind: "owed", summary: full.summary, owed: full.owed, children }];
      }
      return children.length > 0 ? [{ kind: "context", change: node.change, children }] : [];
    });
  const forest = changeForest(new Map([...glances].map(([change, { parent }]) => [change, parent])));
  const pruneWorkspaces = (nodes: readonly ChangeNode[]): WorkspaceNode[] =>
    nodes.flatMap((node) => {
      const children = pruneWorkspaces(node.children);
      const workspace = workspaces.get(node.change);
      const { landed, archived } = glance(node.change);
      const held = workspace === undefined ? undefined : { workspace, landed, archived };
      return held !== undefined || children.length > 0 ? [{ change: node.change, held, children }] : [];
    });
  // A workspace on a branch that is no change still shows — its name still
  // opens a page — flat, with the log-borne notes blank.
  const loose = [...workspaces].flatMap(([change, workspace]): WorkspaceNode[] =>
    glances.has(change) ? [] : [{ change, held: { workspace, landed: false, archived: false }, children: [] }],
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
 * A cell naming `summary`'s change in its status paint. The tree guide rides
 * alongside untargeted and plain — structure, like the table chrome —
 * keeping the link on exactly the name.
 */
function changeCell(summary: ChangeSummary, guide: string, as: UserName | undefined): Cell {
  const name = span(summary.change, {
    style: stepStyle(summary.nextStep),
    target: { kind: "change", change: summary.change, as },
  });
  return guide === "" ? name : [span(guide), name];
}

/** A context ancestor's cell: the whole row dims, tree guide included, the link staying on the name. */
function contextCell(change: ChangeName, guide: string, as: UserName | undefined): Cell {
  const name = span(change, { style: "context", target: { kind: "change", change, as } });
  return guide === "" ? name : [span(guide, { style: "context" }), name];
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
function workspacesSection(forest: readonly WorkspaceNode[], as: UserName | undefined): Node {
  const rows = treeRows(forest).map(({ node: { change, held }, guide }): readonly Cell[] => {
    const style = held === undefined ? "context" : undefined;
    const name = span(change, { style, target: { kind: "change", change, as } });
    const notes =
      held === undefined
        ? []
        : [
            ...(held.workspace.dirty ? ["dirty"] : []),
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

export function homeDoc(page: HomePage): Doc {
  const reviewRows = treeRows(page.review).map(({ node, guide }): readonly Cell[] =>
    node.kind === "owed"
      ? [changeCell(node.summary, guide, page.as), span(String(node.owed.length))]
      : [contextCell(node.change, guide, page.as), span("")],
  );
  const ownedRows = treeRows(page.owned).map(({ node, guide }): readonly Cell[] =>
    node.kind === "owned"
      ? [changeCell(node.summary, guide, page.as), stepSpan(node.summary, page.as)]
      : [contextCell(node.change, guide, page.as), span(node.step ?? "", { style: "context" })],
  );
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
      ...(page.workspaces.length === 0 ? [] : [{ spans: [] }, workspacesSection(page.workspaces, page.as)]),
      ...fetchedFooter(page.fetched),
    ],
    page.broken.map(({ change, message }) => `${change}: ${message}`),
  );
}
