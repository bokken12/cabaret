import { z } from "zod";
import { ChangeID, type ChangeMeta, FilePath, type Ref, Span, TimestampMs, Username } from "./types.ts";

export type LogAction =
  | { readonly kind: "add-parent"; readonly parent: ChangeID }
  | { readonly kind: "remove-parent"; readonly parent: ChangeID }
  | { readonly kind: "add-owner"; readonly owner: Username }
  | { readonly kind: "remove-owner"; readonly owner: Username }
  | { readonly kind: "mark"; readonly file: FilePath; readonly span: Span };
export const LogAction = {
  schema: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("add-parent"), parent: ChangeID.schema }),
    z.object({ kind: z.literal("remove-parent"), parent: ChangeID.schema }),
    z.object({ kind: z.literal("add-owner"), owner: Username.schema }),
    z.object({ kind: z.literal("remove-owner"), owner: Username.schema }),
    z.object({ kind: z.literal("mark"), file: FilePath.schema, span: Span.schema }),
  ]),
};

export type LogEntry = { readonly timestamp: TimestampMs; readonly user: Username; readonly action: LogAction };
export const LogEntry = {
  schema: z.object({ timestamp: TimestampMs.schema, user: Username.schema, action: LogAction.schema }),
};

/** Ref holding a change's log: a commit whose tree contains {@link LOG_FILE}. */
export function changeLogRef(change: ChangeID): Ref {
  return `refs/cabaret/changes/${change}` as Ref;
}

/** JSONL file of {@link LogEntry}s within a change log's tree. */
export const LOG_FILE = "log.jsonl" as FilePath;

/** Parses a change log into entries in apply order. Writers keep the file sorted by timestamp. */
export function readChangeLog(content: string): LogEntry[] {
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LogEntry.schema.parse(JSON.parse(line)));
}

/** Applies a single log entry to meta in place. */
export function applyEntry(meta: ChangeMeta, entry: LogEntry): void {
  const { user, action } = entry;
  switch (action.kind) {
    case "add-owner":
      meta.owners.add(action.owner);
      break;
    case "remove-owner":
      meta.owners.delete(action.owner);
      break;
    case "add-parent":
      meta.parents.add(action.parent);
      break;
    case "remove-parent":
      meta.parents.delete(action.parent);
      break;
    case "mark": {
      const spans = meta.brain.get(user) ?? new Map<FilePath, Span>();
      spans.set(action.file, action.span);
      meta.brain.set(user, spans);
      break;
    }
    default:
      action satisfies never;
  }
}

/** Folds log entries (in apply order, see {@link readChangeLog}) into the change's current metadata. */
export function foldMeta(id: ChangeID, entries: ReadonlyArray<LogEntry>): ChangeMeta {
  const meta: ChangeMeta = { id, owners: new Set(), parents: new Set(), brain: new Map() };
  for (const entry of entries) applyEntry(meta, entry);
  return meta;
}
