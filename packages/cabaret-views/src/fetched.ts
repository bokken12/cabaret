import type { TimestampMs } from "cabaret-core";
import { type Line, span } from "./doc.js";

/**
 * The dimmed closing line dating the origin readings a page rests on, with
 * the blank line standing it off — or nothing when no fetch is known.
 */
export function fetchedFooter(fetched: TimestampMs | undefined): readonly Line[] {
  if (fetched === undefined) {
    return [];
  }
  // Whole seconds: milliseconds would be noise at a glance.
  const time = `${new Date(fetched).toISOString().slice(0, 19)}Z`;
  return [{ spans: [] }, { spans: [span(`fetched ${time}`, { style: "context" })] }];
}
