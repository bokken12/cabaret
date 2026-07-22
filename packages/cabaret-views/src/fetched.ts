import type { TimestampMs } from "cabaret-core";
import { type Line, span } from "./doc.js";

/** How long ago `at` was, floored to its largest fitting unit. */
export function age(at: TimestampMs, now: TimestampMs): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return `${Math.floor(days / 7)}w`;
}

/**
 * The dimmed closing line dating the origin readings a page rests on, with
 * the blank line standing it off — or nothing when no fetch is known. The
 * age rather than the wall-clock time: the line answers how stale the
 * readings are, which matters exactly when the answer has grown large.
 */
export function fetchedFooter(fetched: TimestampMs | undefined, now: TimestampMs): readonly Line[] {
  if (fetched === undefined) {
    return [];
  }
  return [{ spans: [] }, { spans: [span(`fetched ${age(fetched, now)} ago`, { style: "context" })] }];
}
