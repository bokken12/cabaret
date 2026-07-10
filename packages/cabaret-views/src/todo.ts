import {
  type Backend,
  type ChangeNode,
  type ChangeSummary,
  changeForest,
  currentParent,
  type ForgeChange,
  type ForgeLocator,
  type ForgeSnapshot,
  type RefName,
  summarizeChange,
  type TimestampMs,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, span } from "./doc.js";
import { type Cell, table } from "./table.js";

/**
 * One row of the todo page: a change, or an open forge change with no
 * change log yet, standing in for the change importing it would create.
 */
export type TodoItem =
  | { readonly kind: "change"; readonly summary: ChangeSummary }
  | { readonly kind: "forge-change"; readonly change: ForgeChange };

/** A change to act on and the changes stacked on it. */
export interface TodoNode {
  readonly item: TodoItem;
  readonly children: readonly TodoNode[];
}

/** What awaits one user's attention. */
export interface TodoPage {
  /** Unlanded changes with files left for the user to review, sorted by name. */
  readonly review: readonly TodoItem[];
  /**
   * The user's unlanded changes as a forest along parent links, forge changes
   * the user authored included. A change that is landed or someone else's
   * stays only while kept children hang from it.
   */
  readonly owned: readonly TodoNode[];
  /** Which forge the page's forge changes mirror and when, absent without a snapshot. */
  readonly forge?: { readonly locator: ForgeLocator; readonly takenAt: TimestampMs } | undefined;
}

function itemName(item: TodoItem): RefName {
  return item.kind === "change" ? item.summary.change : item.change.head;
}

/** Files with review left: for a forge change, every file it touches, since the user has reviewed none. */
function itemReview(item: TodoItem): number {
  return item.kind === "change" ? item.summary.reviewLeft.length : item.change.changedFiles;
}

function itemNextStep(item: TodoItem): string {
  return item.kind === "change" ? item.summary.nextStep : "import";
}

export async function todoPage(backend: Backend, user: UserName, snapshot?: ForgeSnapshot): Promise<TodoPage> {
  const summaries = new Map<RefName, ChangeSummary>();
  const parents = new Map<RefName, RefName>();
  for (const change of await backend.listChanges()) {
    const entries = await backend.readLog(change);
    summaries.set(change, await summarizeChange(backend, change, entries, user));
    parents.set(change, currentParent(change, entries));
  }
  // Open forge changes with no log yet, keyed by the change importing them
  // would create. Those sharing a head (one branch opened against several
  // parents) collapse to the oldest.
  const unimported = new Map<RefName, ForgeChange>();
  if (snapshot !== undefined) {
    for (const { change } of [...snapshot.changes].sort((a, b) => a.change.id - b.change.id)) {
      if (!summaries.has(change.head) && !unimported.has(change.head)) {
        unimported.set(change.head, change);
        parents.set(change.head, change.parent);
      }
    }
  }
  const item = (change: RefName): TodoItem => {
    const summary = summaries.get(change);
    if (summary !== undefined) {
      return { kind: "change", summary };
    }
    const found = unimported.get(change);
    if (found === undefined) {
      throw new Error(`change vanished while summarizing: ${change}`);
    }
    return { kind: "forge-change", change: found };
  };
  const mine = (candidate: TodoItem): boolean =>
    candidate.kind === "change"
      ? candidate.summary.landed === undefined && candidate.summary.owner === user
      : candidate.change.author === user;
  const prune = (nodes: readonly ChangeNode[]): TodoNode[] =>
    nodes.flatMap((node) => {
      const candidate = item(node.change);
      const children = prune(node.children);
      return mine(candidate) || children.length > 0 ? [{ item: candidate, children }] : [];
    });
  const unlanded = (candidate: TodoItem): boolean =>
    candidate.kind === "forge-change" || candidate.summary.landed === undefined;
  return {
    review: [...summaries.keys(), ...unimported.keys()]
      .sort()
      .map(item)
      .filter((candidate) => unlanded(candidate) && itemReview(candidate) > 0),
    owned: prune(changeForest(parents)),
    ...(snapshot === undefined ? {} : { forge: { locator: snapshot.locator, takenAt: snapshot.takenAt } }),
  };
}

/**
 * A cell naming `item`, resolving to its change or to its forge change
 * awaiting import. The tree guide rides alongside as plain text, keeping the
 * link on exactly the name.
 */
function itemCell(item: TodoItem, guide = ""): Cell {
  const target =
    item.kind === "change"
      ? ({ kind: "change", change: item.summary.change } as const)
      : ({ kind: "forge-change", id: item.change.id, change: item.change.head } as const);
  const name = span(itemName(item), { target });
  return guide === "" ? name : [span(guide), name];
}

export function todoDoc(page: TodoPage): Doc {
  const lines: Line[] = [];
  if (page.review.length > 0) {
    lines.push(
      ...table(
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
        ],
        page.review.map((item) => [itemCell(item), span(String(itemReview(item)))]),
      ),
    );
  }
  if (page.owned.length > 0) {
    if (lines.length > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span("Changes you own:", { style: "heading" })] });
    const rows: (readonly Cell[])[] = [];
    // Each subtree folds under its root's row: the root's own row heads a
    // section named by its change, and every descendant row carries the
    // sections of all its collapsible ancestors.
    const rowSections: (readonly string[])[] = [];
    const walk = (nodes: readonly TodoNode[], prefix: string, top: boolean, enclosing: readonly string[]): void => {
      nodes.forEach(({ item, children }, i) => {
        const last = i === nodes.length - 1;
        const sections = children.length === 0 ? enclosing : [...enclosing, itemName(item)];
        rows.push([
          itemCell(item, top ? "" : `${prefix}${last ? "└─ " : "├─ "}`),
          span(itemReview(item) === 0 ? "" : String(itemReview(item))),
          span(itemNextStep(item)),
        ]);
        rowSections.push(sections);
        walk(children, top ? "" : `${prefix}${last ? "   " : "│  "}`, false, sections);
      });
    };
    walk(page.owned, "", true, []);
    lines.push(
      ...table(
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
          { header: "next step", align: "left" },
        ],
        rows,
      ).map((line, i) => {
        // table() lays out two rules and a header row before the data rows.
        const sections = rowSections[i - 3];
        return sections === undefined || sections.length === 0 ? line : { ...line, sections };
      }),
    );
  }
  if (lines.length === 0) {
    lines.push({ spans: [span("Nothing to do.")] });
  }
  // Forge changes come from a mirror, not the forge itself; saying when it
  // was taken keeps a stale page from being mistaken for the forge's truth.
  if (page.forge !== undefined) {
    lines.push({ spans: [] });
    lines.push({ spans: [span(`${page.forge.locator} synced ${new Date(page.forge.takenAt).toISOString()}`)] });
  }
  return { lines };
}
