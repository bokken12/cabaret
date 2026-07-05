import type { ChangeSummary, CommitHash } from "cabaret-core";
import { type Doc, type Line, span } from "./doc.js";
import { table } from "./table.js";

/** Hashes display abbreviated; full hashes travel in targets, never prose. */
function shortHash(hash: CommitHash): string {
  return hash.slice(0, 12);
}

export function showDoc(summary: ChangeSummary): Doc {
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
  const lines: Line[] = [
    { spans: [span(summary.change, { style: "heading", target: { kind: "change", change: summary.change } })] },
    { spans: [span("=".repeat(summary.change.length))] },
    { spans: [] },
    ...table(
      [
        { header: "attribute", align: "left" },
        { header: "value", align: "left" },
      ],
      attributes.map(([attribute, value]) => [span(attribute), span(value)]),
    ),
  ];
  if (summary.reviewLeft.length > 0) {
    lines.push({ spans: [] }, { spans: [span("Files to review:", { style: "heading" })] });
    for (const file of summary.reviewLeft) {
      lines.push({
        spans: [span("  "), span(file, { target: { kind: "file", change: summary.change, file } })],
      });
    }
  }
  return { lines };
}
