import type { TimestampMs } from "cabaret-core";
import { type Line, span } from "./doc.js";

/**
 * The dimmed closing line dating the origin readings a page rests on, with
 * the blank line standing it off — or nothing when no fetch is known.
 * Wall-clock time leads and the date trails: fetches are usually recent, so
 * the time is the part worth a glance.
 */
export function fetchedFooter(fetched: TimestampMs | undefined): readonly Line[] {
  if (fetched === undefined) {
    return [];
  }
  const two = (n: number) => String(n).padStart(2, "0");
  const at = new Date(fetched);
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return [{ spans: [] }, { spans: [span(`fetched ${time}, ${date}`, { style: "context" })] }];
}
