import {
  type Backend,
  type ChangeComment,
  type ChangeSummary,
  type CommitHash,
  currentComments,
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
  | {
      readonly kind: "change";
      readonly summary: ChangeSummary;
      readonly comments: readonly ChangeComment[];
    }
  | {
      readonly kind: "request";
      readonly forge: ForgeLocator;
      readonly request: ForgeRequest;
      readonly files: readonly FilePath[];
      readonly comments: readonly ChangeComment[];
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
      const comments = (await opened.listComments(request.id)).map(({ updatedAt, author, body }) => ({
        timestamp: updatedAt,
        user: author,
        text: body,
      }));
      return { kind: "request", forge: opened.locator, request, files: await opened.listFiles(request.id), comments };
    }
  }
  return {
    kind: "change",
    summary: await summarizeChange(backend, change, entries, user),
    comments: await currentComments(entries),
  };
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

/** The comments section: each comment's time and author, then its indented text. */
function commentsSection(comments: readonly ChangeComment[]): Line[] {
  if (comments.length === 0) {
    return [];
  }
  const lines: Line[] = [{ spans: [] }, { spans: [span("Comments:", { style: "heading" })] }];
  comments.forEach(({ timestamp, user, text }, index) => {
    // A blank line between comments, since consecutive comments would
    // otherwise run together.
    if (index > 0) {
      lines.push({ spans: [] });
    }
    lines.push({ spans: [span(`  ${new Date(timestamp).toISOString()} ${user}`)] });
    for (const line of text.split("\n")) {
      lines.push({ spans: line === "" ? [] : [span(`    ${line}`)] });
    }
  });
  return lines;
}

export function showDoc(page: ShowPage): Doc {
  if (page.kind === "request") {
    const { forge, request, files } = page;
    // The heading resolves to the request so hosts can find what to import
    // from anywhere on the page, but on the jump tier: as a link it would
    // only lead back here.
    const heading = span(request.head, {
      style: "heading",
      target: { kind: "request", request: request.id, change: request.head },
      tier: "jump",
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
        ...commentsSection(page.comments),
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
  // No target: the heading names the page itself.
  const heading = span(summary.change, { style: "heading" });
  return {
    lines: [
      ...header(heading, attributes),
      ...commentsSection(page.comments),
      ...filesToReview(summary.reviewLeft, (file) => ({ kind: "file", change: summary.change, file })),
    ],
  };
}
