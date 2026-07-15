/** Assembles the selected views of each 4-way hunk into nested, labeled
 *  output. Ported from Iron's [patdiff4/lib/hunk.ml], minus scrutiny and
 *  per-user view filtering: every selected view is shown. */

import type { Diamond as DiamondT } from "./diamond.js";
import * as Diamond from "./diamond.js";
import type * as DiffAlgo from "./diff-algo.js";
import * as DiffAlgoId from "./diff-algo-id.js";
import type * as Diff4Class from "./diff4-class.js";
import * as Header from "./header.js";

type Index = { readonly current: number; readonly total: number };

const indexToString = (t: Index): string => `${t.current + 1}/${t.total}`;

const indexWithSpaceIfNonTrivial = (t: Index): string => (t.total <= 1 ? "" : ` ${indexToString(t)}`);

/** Nested blocks of lines, rendered with box-drawing pipes so a reader can
 *  see where each view of a hunk begins and ends. */
type Nesting =
  | { readonly kind: "Lines"; readonly lines: readonly DiffAlgo.Line[] }
  | { readonly kind: "Group"; readonly group: readonly Nesting[] };

/** Decoration around the diff lines: titles, labels, and grouping pipes. */
const plain = (text: string): DiffAlgo.Line => ({ text, kind: undefined, provenance: {} });

const lines = (l: readonly DiffAlgo.Line[]): Nesting => ({ kind: "Lines", lines: l });
const block = (l: readonly DiffAlgo.Line[]): Nesting => ({ kind: "Group", group: [lines(l)] });
const group = (g: readonly Nesting[]): Nesting => ({ kind: "Group", group: g });

/** Use the grouping syntax only where at least two elements group together,
 *  so single-view hunks render without any decoration. */
const simplifyInDepth = (t: Nesting): Nesting => {
  if (t.kind === "Lines") return t;
  const g = t.group;
  if (g.length === 0) return lines([]);
  if (g.length === 1) {
    const only = g[0] as Nesting;
    if (only.kind === "Group") return simplifyInDepth(only);
    return t;
  }
  if (g.length === 2 && (g[0] as Nesting).kind === "Lines" && (g[1] as Nesting).kind === "Group") {
    const first = g[0] as Nesting;
    const second = g[1] as Nesting & { kind: "Group" };
    if (second.group.length === 0) return group([first]);
    if (second.group.length === 1) return simplifyInDepth(group([first, second.group[0] as Nesting]));
    const inner = second.group.map(simplifyInDepth);
    if (inner.every((child) => child.kind === "Group" || child.lines.length === 0)) {
      return group([first, ...inner]);
    }
    return group([first, group(inner)]);
  }
  return group(g.map(simplifyInDepth));
};

const simplify = (t: Nesting): readonly Nesting[] => {
  const simplified = simplifyInDepth(t);
  if (simplified.kind === "Group") {
    if (simplified.group.length === 1) return simplify(simplified.group[0] as Nesting);
    return simplified.group;
  }
  return [simplified];
};

/** Render one already-simplified top-level block: bare lines, or a box. */
const renderBlock = (t: Nesting, output: Header.Output4): readonly DiffAlgo.Line[] => {
  const [pipe, open, close] = output === "Ansi" ? ["│ ", "┌", "└"] : ["| ", "_", "|_"];
  const loop = (t: Nesting, nesting: number): readonly DiffAlgo.Line[] => {
    const prefix = pipe.repeat(nesting);
    if (t.kind === "Lines") return t.lines.map((line) => ({ ...line, text: prefix + line.text }));
    return [plain(prefix + open), ...t.group.flatMap((child) => loop(child, nesting + 1)), plain(prefix + close)];
  };
  return loop(t, 0);
};

const nestingToLines = (t: Nesting, output: Header.Output4): readonly DiffAlgo.Line[] =>
  simplify(t).flatMap((child) => renderBlock(child, output));

export type Hunk = {
  readonly headerFileName: string;
  readonly revNames: DiamondT<string>;
  readonly fileNames: DiamondT<string>;
  readonly diff4Class: Diff4Class.Diff4Class;
  readonly views: readonly DiffAlgo.View[];
};

const nestedViews = (t: Hunk, output: Header.Output4, hunkName?: string): readonly Nesting[] => {
  const blockToLines = (b: DiffAlgo.Block, header?: readonly string[]): Nesting =>
    block([...(header ?? []).map(plain), ...b.hint.map(plain), ...b.lines]);
  const total = t.views.length;
  return t.views.map((view, current) => {
    const viewName = DiffAlgoId.toString(view.id);
    const header =
      total > 1 || !DiffAlgoId.isSimpleDiff(view.id)
        ? [
            Header.title(
              output,
              // Repeat the hunk label only when several views separate it
              // from its last occurrence.
              `${hunkName !== undefined && total > 1 ? `${hunkName} ` : ""}View${indexWithSpaceIfNonTrivial({ current, total })} : ${viewName}`,
            ),
          ]
        : undefined;
    if (view.blocks.length === 1) {
      return group([blockToLines(view.blocks[0] as DiffAlgo.Block, header)]);
    }
    const blocks = view.blocks.map((b) => blockToLines(b));
    return group(header === undefined ? blocks : [lines(header.map(plain)), ...blocks]);
  });
};

const alignAlist = (alist: readonly (readonly [string, string])[]): readonly string[] => {
  const maxLen = alist.reduce((acc, [label]) => Math.max(acc, label.length), 0);
  return alist.map(([label, data]) => `${label.padEnd(maxLen)} = ${data}`);
};

const fileAndRevNamesInformation = (args: {
  t: Hunk;
  output: Header.Output4;
  useFileSeparator: boolean;
  inScope: Hunk | undefined;
}): readonly string[] => {
  const { t, output, useFileSeparator, inScope } = args;
  const includeRevNames = inScope === undefined || !Diamond.forAll2(inScope.revNames, t.revNames, (a, b) => a === b);
  const includeFileNames = inScope === undefined || !Diamond.forAll2(inScope.fileNames, t.fileNames, (a, b) => a === b);
  const [length, filename] = Header.filenameHeader(output, t.headerFileName);
  const out: string[] = [];
  if (includeFileNames && useFileSeparator) out.push(Header.filenameSeparator(output, length));
  if (includeFileNames) out.push(filename);
  if (includeFileNames) {
    const files = Diamond.prettyShortDescription({ label: "file", diamond: t.fileNames });
    if (files.length > 1) out.push(...alignAlist(files));
  }
  if (includeRevNames) {
    const revs = Diamond.prettyShortDescription({ label: "", diamond: t.revNames });
    out.push(revs.map(([name, rev]) => `${name} ${rev}`).join(" | "));
  }
  return out;
};

/** One hunk's two top-level blocks: its file/rev-name header lines and its
 *  grouped views, labeled `name` when several hunks tell themselves apart. */
type HunkBlocks = { readonly header: Nesting; readonly views: Nesting; readonly name: string | undefined };

const hunkBlocksList = (hunks: readonly Hunk[], output: Header.Output4): readonly HunkBlocks[] => {
  const useFileSeparator = new Set(hunks.map((hunk) => hunk.headerFileName)).size > 1;
  const total = hunks.length;
  let inScope: Hunk | undefined;
  return hunks.map((t, current) => {
    const hunkName = total > 1 ? `Hunk ${indexToString({ current, total })}` : undefined;
    const views: Nesting[] = nestedViews(t, output, hunkName).slice();
    if (hunkName !== undefined) views.unshift(lines([plain(Header.title(output, hunkName))]));
    const header = lines(fileAndRevNamesInformation({ t, output, useFileSeparator, inScope }).map(plain));
    inScope = t;
    return { header, views: group(views), name: hunkName };
  });
};

export const listToLines = (hunks: readonly Hunk[], output: Header.Output4): readonly DiffAlgo.Line[] =>
  nestingToLines(group(hunkBlocksList(hunks, output).flatMap(({ header, views }) => [header, views])), output);

/** One hunk's rendered display lines; `title` indexes its own title line —
 *  what a host may fold the hunk down to — present exactly when hunks label
 *  themselves, which a lone hunk never does. */
export type HunkLines = {
  readonly lines: readonly DiffAlgo.Line[];
  readonly title: number | undefined;
};

/** The lines of `listToLines` grouped per hunk. */
export const listToLineGroups = (hunks: readonly Hunk[], output: Header.Output4): readonly HunkLines[] => {
  const blocks = hunkBlocksList(hunks, output);
  if (blocks.length <= 1) {
    const all = listToLines(hunks, output);
    return all.length === 0 ? [] : [{ lines: all, title: undefined }];
  }
  // With several hunks the top-level simplify visits each block on its own
  // (its block-merging special case needs exactly two blocks), so rendering
  // block by block reproduces listToLines' lines exactly.
  return blocks.map(({ header, views, name }) => {
    const headerLines = renderBlock(simplifyInDepth(header), output);
    const viewLines = renderBlock(simplifyInDepth(views), output);
    // The label makes the views group at least two children, so it survives
    // simplification as a box whose first inner line is the title.
    const title = headerLines.length + 1;
    const all = [...headerLines, ...viewLines];
    const titled = all[title];
    if (name === undefined || titled === undefined || !titled.text.includes(name)) {
      throw new Error(`hunk title not at its expected line: ${JSON.stringify(titled?.text)}`);
    }
    return { lines: all, title };
  });
};
