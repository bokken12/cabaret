import {
  type Backend,
  type ChangeName,
  type ChangeNode,
  type ChangeSummary,
  changeDiff,
  changeForest,
  currentArchived,
  currentParent,
  type FilePath,
  isReviewing,
  isSelf,
  type LogEntry,
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
import { type Cell, type Column, table, tableParts } from "./table.js";
import { type WorkspaceNote, workspaceNotes } from "./workspaces.js";

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
   * Every workspace on this device with a name checked out, change or not,
   * in workspace order (the primary working tree first). This is where a
   * workspace whose change has landed gets noticed — and reclaimed.
   */
  readonly workspaces: readonly WorkspaceEntry[];
  /** When this clone last fetched from origin, when known. */
  readonly fetched: TimestampMs | undefined;
}

/** A checked-out name — not necessarily a change — and the workspace holding it on this device. */
export interface WorkspaceEntry {
  readonly change: ChangeName;
  readonly workspace: WorkspaceNote;
  /** Whether the change has landed, leaving the workspace ready to remove. */
  readonly landed: boolean;
  /** Whether the change is archived, likewise leaving the workspace idle. */
  readonly archived: boolean;
}

/** Changes read at once: a local backend spawns a process per query, a network one pays a round-trip. */
const READ_CONCURRENCY = 32;

/** One change's readings for the page, or what broke reading them. */
type ChangeReading =
  | {
      readonly kind: "read";
      readonly summary: ChangeSummary;
      readonly owed: readonly FilePath[];
    }
  | { readonly kind: "broken"; readonly message: string };

/** What a change's log alone tells the page, before any derivation. */
type LogReading = {
  readonly entries: readonly LogEntry[];
  readonly parent: ChangeName;
  readonly landed: boolean;
  readonly archived: boolean;
};

async function readChange(
  backend: Backend,
  self: Self,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<ChangeReading> {
  const diff = await changeDiff(backend, change, entries);
  const summary = await summarizeChange(backend, change, entries, self.user, diff);
  // Obligations ask nothing of a user outside the reviewing set — a
  // membership the log alone decides, sparing the obligations files of
  // most changes. An empty reviewLeft already counts the user toward
  // every obligation — though it says nothing about their aliases, whose
  // obligations each count that identity's own reviews. A change with
  // conflict markers asks review of nobody: fixing them rewrites the
  // tip, so reading it now is wasted.
  const asked =
    summary.landed === undefined &&
    !summary.archived &&
    summary.conflicts.length === 0 &&
    (summary.reviewLeft.length > 0 || self.aliases.size > 0) &&
    isReviewing(self, change, entries);
  return {
    kind: "read",
    summary,
    owed: asked ? await reviewOwed(backend, entries, summary.owner, self, diff) : [],
  };
}

export async function homePage(backend: Backend, as?: UserName): Promise<HomePage> {
  const acting = await selfAs(backend, as);
  const self = acting.self;
  const workspaces = await workspaceNotes(backend);
  const changes = [...(await backend.listChanges())].sort();
  // Two passes: the logs alone say which changes are set aside, and only the
  // live ones — with the ancestors their trees hang from — earn the full
  // reading, whose derivations dominate the page's cost. A landed or
  // archived leaf contributes its parent link and workspace note straight
  // from the log; it renders nowhere else on the page.
  const brokenBy = new Map<ChangeName, string>();
  const logReadings = await mapConcurrent(changes, READ_CONCURRENCY, async (change): Promise<LogReading | string> => {
    try {
      const entries = await backend.readLog(change);
      return {
        entries,
        parent: currentParent(change, entries),
        landed: landedMerge(entries) !== undefined,
        archived: currentArchived(entries),
      };
    } catch (error) {
      // Only state problems isolate to their change; a bug still throws.
      if (!(error instanceof UserError)) {
        throw error;
      }
      return error.message;
    }
  });
  const logs = new Map<ChangeName, LogReading>();
  changes.forEach((change, index) => {
    const reading = logReadings[index];
    if (reading === undefined) {
      throw new Error(`change read no log reading: ${change}`);
    }
    if (typeof reading === "string") {
      brokenBy.set(change, reading);
    } else {
      logs.set(change, reading);
    }
  });
  const parents = new Map([...logs].map(([change, { parent }]) => [change, parent] as const));
  const wanted = new Set<ChangeName>();
  for (const [change, { landed, archived }] of logs) {
    if (landed || archived) {
      continue;
    }
    let at: ChangeName | undefined = change;
    while (at !== undefined && !wanted.has(at) && logs.has(at)) {
      wanted.add(at);
      at = parents.get(at);
    }
  }
  const kept = changes.filter((change) => wanted.has(change));
  // Each change reads independently; assembling in `changes` order afterwards
  // keeps the page deterministic whatever order the readings finish in.
  const readings = await mapConcurrent(kept, READ_CONCURRENCY, async (change): Promise<ChangeReading> => {
    try {
      const log = logs.get(change);
      if (log === undefined) {
        throw new Error(`kept change has no log reading: ${change}`);
      }
      return await readChange(backend, self, change, log.entries);
    } catch (error) {
      if (!(error instanceof UserError)) {
        throw error;
      }
      return { kind: "broken", message: error.message };
    }
  });
  const summaries = new Map<ChangeName, ChangeSummary>();
  const owedFiles = new Map<ChangeName, readonly FilePath[]>();
  kept.forEach((change, index) => {
    const reading = readings[index];
    if (reading === undefined) {
      throw new Error(`change read no reading: ${change}`);
    }
    if (reading.kind === "broken") {
      brokenBy.set(change, reading.message);
      // A broken change leaves the forest, as one broken at the log does;
      // its children stand as roots.
      parents.delete(change);
      logs.delete(change);
      return;
    }
    summaries.set(change, reading.summary);
    if (reading.owed.length > 0) {
      owedFiles.set(change, reading.owed);
    }
  });
  const broken: BrokenChange[] = changes.flatMap((change) => {
    const message = brokenBy.get(change);
    return message === undefined ? [] : [{ change, message }];
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
      // A change outside the full reading — set aside, with nothing live
      // stacked on it — is nobody's to act on.
      const candidate = summaries.get(node.change);
      const children = pruneOwned(node.children);
      const mine =
        candidate !== undefined &&
        candidate.landed === undefined &&
        !candidate.archived &&
        isSelf(self, candidate.owner);
      return mine || children.length > 0 ? [{ summary: summary(node.change), context: !mine, children }] : [];
    });
  const pruneReview = (nodes: readonly ChangeNode[]): ReviewNode[] =>
    nodes.flatMap((node) => {
      const children = pruneReview(node.children);
      const owed = owedFiles.get(node.change) ?? [];
      return owed.length > 0 || children.length > 0 ? [{ summary: summary(node.change), owed, children }] : [];
    });
  const forest = changeForest(parents);
  const entries = [...workspaces].map(([change, workspace]): WorkspaceEntry => {
    // Every workspace shows, even one on a branch that is no change — its
    // name still opens a page — with the log-borne notes blank.
    const found = logs.get(change);
    return {
      change,
      workspace,
      landed: found?.landed ?? false,
      archived: found?.archived ?? false,
    };
  });
  return {
    as: acting.as,
    review: pruneReview(forest),
    owned: pruneOwned(forest),
    broken,
    workspaces: entries,
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

/** The workspaces section: one row per change checked out on this device. */
function workspacesSection(entries: readonly WorkspaceEntry[], as: UserName | undefined): Node {
  const rows = entries.map(({ change, workspace, landed, archived }): readonly Cell[] => [
    span(change, { target: { kind: "change", change, as } }),
    span(
      [...(workspace.dirty ? ["dirty"] : []), ...(landed ? ["landed"] : []), ...(archived ? ["archived"] : [])].join(
        ", ",
      ),
    ),
  ]);
  return section(
    { spans: [span("Workspaces on this device:", { style: "heading" })] },
    table(
      [
        { header: "change", align: "left" },
        { header: "note", align: "left" },
      ],
      rows,
    ),
  );
}

export function homeDoc(page: HomePage): Doc {
  const reviewRows = treeRows(page.review).map(({ node: { summary, owed }, guide }): readonly Cell[] => {
    const style = owed.length === 0 ? "context" : undefined;
    return [changeCell(summary, guide, page.as, style), span(owed.length === 0 ? "" : String(owed.length))];
  });
  const ownedRows = treeRows(page.owned).map(({ node: { summary, context }, guide }): readonly Cell[] => {
    const style = context ? "context" : undefined;
    return [changeCell(summary, guide, page.as, style), stepSpan(summary.nextStep, summary.change, page.as, style)];
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
      ...(page.workspaces.length === 0 ? [] : [{ spans: [] }, workspacesSection(page.workspaces, page.as)]),
      ...fetchedFooter(page.fetched),
    ],
    page.broken.map(({ change, message }) => `${change}: ${message}`),
  );
}
