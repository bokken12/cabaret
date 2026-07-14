import {
  type Backend,
  type ChangeNode,
  type ChangeSummary,
  changeForest,
  currentParent,
  type FilePath,
  type RefName,
  reviewOwed,
  summarizeChange,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, span } from "./doc.js";
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

export async function todoPage(backend: Backend, user: UserName): Promise<TodoPage> {
  const summaries = new Map<RefName, ChangeSummary>();
  const parents = new Map<RefName, RefName>();
  const review: ReviewTodo[] = [];
  for (const change of [...(await backend.listChanges())].sort()) {
    const entries = await backend.readLog(change);
    const candidate = await summarizeChange(backend, change, entries, user);
    summaries.set(change, candidate);
    parents.set(change, currentParent(change, entries));
    // An empty reviewLeft already counts the user toward every obligation, so
    // only a change they have review left on can owe them anything.
    if (candidate.landed === undefined && candidate.reviewLeft.length > 0) {
      const owed = await reviewOwed(backend, entries, candidate.owner, user, candidate.base, candidate.tip);
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
      const mine = candidate.landed === undefined && candidate.owner === user;
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
  const lines: Line[] = [];
  if (page.review.length > 0) {
    lines.push(
      ...table(
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
        ],
        page.review.map(({ summary, owed }) => [changeCell(summary), span(String(owed.length))]),
      ),
    );
  }
  if (page.owned.length > 0) {
    if (lines.length > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span("Changes you own:", { style: "heading" })] });
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
    lines.push(
      ...table(
        [
          { header: "change", align: "left" },
          { header: "review", align: "right" },
          { header: "next step", align: "left" },
        ],
        rows,
      ),
    );
  }
  if (lines.length === 0) {
    lines.push({ spans: [span("Nothing to do.")] });
  }
  return { lines };
}
