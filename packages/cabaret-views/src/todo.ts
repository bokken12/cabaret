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

/**
 * One row of the todo page: a change, or an open forge request with no
 * change log yet, standing in for the change importing it would create.
 */
export type TodoItem =
  | { readonly kind: "change"; readonly summary: ChangeSummary }
  | { readonly kind: "request"; readonly request: ForgeRequest };

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
   * The user's unlanded changes as a forest along parent links, requests the
   * user authored included. A change that is landed or someone else's stays
   * only while kept children hang from it.
   */
  readonly owned: readonly TodoNode[];
}

function itemName(item: TodoItem): RefName {
  return item.kind === "change" ? item.summary.change : item.request.head;
}

/** Files with review left: for a request, every file it touches, since the user has reviewed none. */
function itemReview(item: TodoItem): number {
  return item.kind === "change" ? item.summary.reviewLeft.length : item.request.changedFiles;
}

function itemNextStep(item: TodoItem): string {
  return item.kind === "change" ? item.summary.nextStep : "import";
}

export async function todoPage(backend: Backend, user: UserName, forge?: Forge): Promise<TodoPage> {
  const summaries = new Map<RefName, ChangeSummary>();
  const parents = new Map<RefName, RefName>();
  for (const change of await backend.listChanges()) {
    const entries = await backend.readLog(change);
    summaries.set(change, await summarizeChange(backend, change, entries, user));
    parents.set(change, currentParent(change, entries));
  }
  // Open requests with no log yet, keyed by the change importing them would
  // create. Requests sharing a head (one branch opened against several bases)
  // collapse to the oldest.
  const requests = new Map<RefName, ForgeRequest>();
  if (forge !== undefined) {
    for (const request of [...(await forge.listOpenRequests())].sort((a, b) => a.id - b.id)) {
      if (!summaries.has(request.head) && !requests.has(request.head)) {
        requests.set(request.head, request);
        parents.set(request.head, request.base);
      }
    }
  }
  const item = (change: RefName): TodoItem => {
    const summary = summaries.get(change);
    if (summary !== undefined) {
      return { kind: "change", summary };
    }
    const request = requests.get(change);
    if (request === undefined) {
      throw new Error(`change vanished while summarizing: ${change}`);
    }
    return { kind: "request", request };
  };
  const mine = (candidate: TodoItem): boolean =>
    candidate.kind === "change"
      ? candidate.summary.landed === undefined && candidate.summary.owner === user
      : candidate.request.author === user;
  const prune = (nodes: readonly ChangeNode[]): TodoNode[] =>
    nodes.flatMap((node) => {
      const candidate = item(node.change);
      const children = prune(node.children);
      return mine(candidate) || children.length > 0 ? [{ item: candidate, children }] : [];
    });
  const unlanded = (candidate: TodoItem): boolean =>
    candidate.kind === "request" || candidate.summary.landed === undefined;
  return {
    review: [...summaries.keys(), ...requests.keys()]
      .sort()
      .map(item)
      .filter((candidate) => unlanded(candidate) && itemReview(candidate) > 0),
    owned: prune(changeForest(parents)),
  };
}

/** A cell naming `item` behind its tree guide, resolving to its change or to its request awaiting import. */
function itemSpan(item: TodoItem, guide = ""): Span {
  const target =
    item.kind === "change"
      ? ({ kind: "change", change: item.summary.change } as const)
      : ({ kind: "request", request: item.request.id } as const);
  return span(`${guide}${itemName(item)}`, { target });
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
        page.review.map((item) => [itemSpan(item), span(String(itemReview(item)))]),
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
      nodes.forEach(({ item, children }, i) => {
        const last = i === nodes.length - 1;
        rows.push([
          itemSpan(item, top ? "" : `${prefix}${last ? "└─ " : "├─ "}`),
          span(itemReview(item) === 0 ? "" : String(itemReview(item))),
          span(itemNextStep(item)),
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
