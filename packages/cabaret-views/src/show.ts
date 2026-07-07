import {
  type Backend,
  type ChangeSummary,
  type CommitHash,
  type FilePath,
  type Forge,
  type ForgeLocator,
  type ForgeRequest,
  type RefName,
  summarizeChange,
  type UserName,
} from "cabaret-core";
import { type Doc, type Line, type Span, span, type Target } from "./doc.js";
import { table } from "./table.js";

/**
 * What the show page displays: a change, or an open forge request with no
 * change log yet, shown as the change importing it would create.
 */
export type ShowPage =
  | { readonly kind: "change"; readonly summary: ChangeSummary }
  | {
      readonly kind: "request";
      readonly forge: ForgeLocator;
      readonly request: ForgeRequest;
      readonly files: readonly FilePath[];
    };

/**
 * Query the show page for `change`. A name with no log yet falls back to its
 * open request on the forge, opened only then — showing a change never pays
 * for the forge.
 */
export async function showPage(
  backend: Backend,
  user: UserName,
  change: RefName,
  forge?: () => Promise<Forge | undefined>,
): Promise<ShowPage> {
  const entries = await backend.readLog(change);
  if (entries.length === 0 && forge !== undefined) {
    const opened = await forge();
    const request = opened === undefined ? undefined : await opened.findRequest(change);
    if (opened !== undefined && request !== undefined) {
      return { kind: "request", forge: opened.locator, request, files: await opened.listFiles(request.id) };
    }
  }
  return { kind: "change", summary: await summarizeChange(backend, change, entries, user) };
}

/** Hashes display abbreviated; full hashes travel in targets, never prose. */
function shortHash(hash: CommitHash): string {
  return hash.slice(0, 12);
}

/** The heading, its rule, and the attribute table every show page opens with. */
function header(heading: Span, attributes: readonly (readonly [string, string])[]): Line[] {
  return [
    { spans: [heading] },
    { spans: [span("=".repeat(heading.text.length))] },
    { spans: [] },
    ...table(
      [
        { header: "attribute", align: "left" },
        { header: "value", align: "left" },
      ],
      attributes.map(([attribute, value]) => [span(attribute), span(value)]),
    ),
  ];
}

/** The files section, each row resolving to `target(file)` when one is given. */
function filesToReview(files: readonly FilePath[], target?: (file: FilePath) => Target): Line[] {
  if (files.length === 0) {
    return [];
  }
  return [
    { spans: [] },
    { spans: [span("Files to review:", { style: "heading" })] },
    ...files.map((file) => ({
      spans: [span("  "), span(file, target === undefined ? {} : { target: target(file) })],
    })),
  ];
}

export function showDoc(page: ShowPage): Doc {
  if (page.kind === "request") {
    const { forge, request, files } = page;
    const heading = span(request.head, {
      style: "heading",
      target: { kind: "request", request: request.id, change: request.head },
    });
    return {
      lines: [
        ...header(heading, [
          ["next step", "import"],
          ["owner", request.author],
          ["parent", request.base],
          ["forge request", `${forge}#${request.id}`],
          ["title", request.title],
        ]),
        // No file targets: the files have no diffs to open until the import.
        ...filesToReview(files),
      ],
    };
  }
  const summary = page.summary;
  const attributes: [string, string][] = [
    ["next step", summary.nextStep],
    ["owner", summary.owner],
    ["parent", summary.parent],
  ];
  if (summary.forgeRequest !== undefined) {
    attributes.push(["forge request", `${summary.forgeRequest.forge}#${summary.forgeRequest.request}`]);
  }
  if (summary.landed !== undefined) {
    attributes.push(["landed", shortHash(summary.landed)]);
  }
  attributes.push(["tip", shortHash(summary.tip)], ["base", shortHash(summary.base)]);
  const heading = span(summary.change, { style: "heading", target: { kind: "change", change: summary.change } });
  return {
    lines: [
      ...header(heading, attributes),
      ...filesToReview(summary.reviewLeft, (file) => ({ kind: "file", change: summary.change, file })),
    ],
  };
}
