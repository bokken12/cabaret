import {
  type Backend,
  type ChangeNode,
  type ChangeSummary,
  changeDiff,
  changeForest,
  currentParent,
  type FilePath,
  isSelf,
  type RefName,
  reviewOwed,
  type Self,
  summarizeChange,
} from "cabaret-core";
import { type Doc, layout, section, span } from "./doc.js";
import { type Cell, table } from "./table.js";

/** A change to act on and the changes stacked on it. */
export interface TodoNode {
  readonly summary: ChangeSummary;
  readonly children: readonly TodoNode[];
}

/** A change the user owes review, and the files still awaiting them. */
export interface ReviewTodo {
  readonly summary: ChangeSummary;
  readonly owed: readonly FilePath[];
}

/** What awaits one user's attention. */
export interface TodoPage {
  /**
   * Unlanded changes with an unsatisfied obligation the user's review can
   * still count toward, sorted by name. A change nobody asked the user to
   * review stays off the page, however much of it they have not read.
   */
  readonly review: readonly ReviewTodo[];
  /**
   * The user's unlanded changes as a forest along parent links. A change that
   * is landed or someone else's stays only while kept children hang from it.
   */
  readonly owned: readonly TodoNode[];
}

export async function todoPage(backend: Backend, self: Self): Promise<TodoPage> {
  const summaries = new Map<RefName, ChangeSummary>();
  const parents = new Map<RefName, RefName>();
  const review: ReviewTodo[] = [];
  for (const change of [...(await backend.listChanges())].sort()) {
    const entries = await backend.readLog(change);
    const diff = await changeDiff(backend, change, entries);
    const candidate = await summarizeChange(backend, change, entries, self.user, diff);
    summaries.set(change, candidate);
    parents.set(change, currentParent(change, entries));
    // An empty reviewLeft already counts the user toward every obligation —
    // though it says nothing about their aliases, whose obligations each
    // count that identity's own reviews.
    if (candidate.landed === undefined && (candidate.reviewLeft.length > 0 || self.aliases.size > 0)) {
      const owed = await reviewOwed(backend, entries, candidate.owner, self, diff);
      if (owed.length > 0) {
        review.push({ summary: candidate, owed });
      }
    }
  }
  const summary = (change: RefName): ChangeSummary => {
    const found = summaries.get(change);
    if (found === undefined) {
      throw new Error(`change vanished while summarizing: ${change}`);
    }
    return found;
  };
  const prune = (nodes: readonly ChangeNode[]): TodoNode[] =>
    nodes.flatMap((node) => {
      const candidate = summary(node.change);
      const children = prune(node.children);
      const mine = candidate.landed === undefined && isSelf(self, candidate.owner);
      return mine || children.length > 0 ? [{ summary: candidate, children }] : [];
    });
  return { review, owned: prune(changeForest(parents)) };
}

/**
 * A cell naming `summary`'s change. The tree guide rides alongside as plain
 * text, keeping the link on exactly the name.
 */
function changeCell(summary: ChangeSummary, guide = ""): Cell {
  const name = span(summary.change, { target: { kind: "change", change: summary.change } });
  return guide === "" ? name : [span(guide), name];
}

export function todoDoc(page: TodoPage): Doc {
  const rows: (readonly Cell[])[] = [];
  const walk = (nodes: readonly TodoNode[], prefix: string, top: boolean): void => {
    nodes.forEach(({ summary, children }, i) => {
      const last = i === nodes.length - 1;
      rows.push([
        changeCell(summary, top ? "" : `${prefix}${last ? "└─ " : "├─ "}`),
        span(summary.reviewLeft.length === 0 ? "" : String(summary.reviewLeft.length)),
        span(summary.nextStep),
      ]);
      walk(children, top ? "" : `${prefix}${last ? "   " : "│  "}`, false);
    });
  };
  walk(page.owned, "", true);
  return layout([
    ...table(
      [
        { header: "change", align: "left" },
        { header: "review", align: "right" },
      ],
      page.review.map(({ summary, owed }) => [changeCell(summary), span(String(owed.length))]),
    ),
    { spans: [] },
    section(
      { spans: [span("Changes you own:", { style: "heading" })] },
      table(
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
          { header: "next step", align: "left" },
        ],
        rows,
      ),
    ),
  ]);
}
