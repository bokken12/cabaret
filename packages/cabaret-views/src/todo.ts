import {
  type Backend,
  type ChangeNode,
  type ChangeSummary,
  changeForest,
  currentParent,
  type Forge,
  type ForgeRequest,
  type RefName,
  summarizeChange,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, type Span, span } from "./doc.js";
import { table } from "./table.js";

/** A change to act on and the changes stacked on it. */
export interface TodoNode {
  readonly summary: ChangeSummary;
  readonly children: readonly TodoNode[];
}

/** What awaits one user's attention. */
export interface TodoPage {
  /** Unlanded changes with files left for the user to review, sorted by name. */
  readonly review: readonly ChangeSummary[];
  /**
   * The user's unlanded changes as a forest along parent links. A change that
   * is landed or someone else's stays only while kept children hang from it.
   */
  readonly owned: readonly TodoNode[];
  /**
   * Open forge requests whose head branch has no change log here, sorted by
   * id: what `gh import` would turn into changes. Empty without a forge.
   */
  readonly unimported: readonly ForgeRequest[];
}

export async function todoPage(backend: Backend, user: UserName, forge?: Forge): Promise<TodoPage> {
  const requests = forge === undefined ? [] : await forge.listOpenRequests();
  const summaries = new Map<RefName, ChangeSummary>();
  const parents = new Map<RefName, RefName>();
  for (const change of await backend.listChanges()) {
    const entries = await backend.readLog(change);
    summaries.set(change, await summarizeChange(backend, change, entries, user));
    parents.set(change, currentParent(change, entries));
  }
  const prune = (nodes: readonly ChangeNode[]): TodoNode[] =>
    nodes.flatMap((node) => {
      const summary = summaries.get(node.change);
      if (summary === undefined) {
        throw new Error(`change vanished while summarizing: ${node.change}`);
      }
      const children = prune(node.children);
      const mine = summary.landed === undefined && summary.owner === user;
      return mine || children.length > 0 ? [{ summary, children }] : [];
    });
  return {
    review: [...summaries.values()].filter(({ landed, reviewLeft }) => landed === undefined && reviewLeft.length > 0),
    owned: prune(changeForest(parents)),
    unimported: requests.filter(({ head }) => !summaries.has(head)).sort((a, b) => a.id - b.id),
  };
}

/** A cell naming `change` behind its tree guide, resolving to it. */
function changeSpan(change: RefName, guide = ""): Span {
  return span(`${guide}${change}`, { target: { kind: "change", change } });
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
        page.review.map(({ change, reviewLeft }) => [changeSpan(change), span(String(reviewLeft.length))]),
      ),
    );
  }
  if (page.owned.length > 0) {
    if (lines.length > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span("Changes you own:", { style: "heading" })] });
    const rows: (readonly Span[])[] = [];
    const walk = (nodes: readonly TodoNode[], prefix: string, top: boolean): void => {
      nodes.forEach(({ summary, children }, i) => {
        const last = i === nodes.length - 1;
        rows.push([
          changeSpan(summary.change, top ? "" : `${prefix}${last ? "└─ " : "├─ "}`),
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
  if (page.unimported.length > 0) {
    if (lines.length > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span("Pull requests:", { style: "heading" })] });
    lines.push(
      ...table(
        [
          { header: "request", align: "right" },
          { header: "change", align: "left" },
          { header: "title", align: "left" },
          { header: "next step", align: "left" },
        ],
        page.unimported.map(({ id, head, title }) => [
          span(`#${id}`, { target: { kind: "request", request: id } }),
          span(head),
          span(title),
          span("import"),
        ]),
      ),
    );
  }
  if (lines.length === 0) {
    lines.push({ spans: [span("Nothing to do.")] });
  }
  return { lines };
}
