import type { ChangeID, FilePath, Revision, Username } from "./types.ts";

export type LogAction =
  | { readonly kind: "set-parent"; readonly parent: ChangeID }
  | { readonly kind: "set-base"; readonly base: Revision }
  | { readonly kind: "set-owner"; readonly owner: Username }
  | { readonly kind: "set-archived"; readonly archived: boolean }
  | { readonly kind: "mark"; readonly file: FilePath; readonly base: Revision; readonly tip: Revision }
  | { readonly kind: "forget"; readonly file: FilePath };

export type LogEntry = { action: LogAction };
