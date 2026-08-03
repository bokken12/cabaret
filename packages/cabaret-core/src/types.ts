import { z } from "zod";

export type NonemptyArray<T> = [T, ...T[]];
export type NonemptyReadonlyArray<T> = readonly [T, ...T[]];
export type NontrivialArray<T> = [T, T, ...T[]];
export type NontrivialReadonlyArray<T> = readonly [T, T, ...T[]];

declare const brand: unique symbol;

export type Branded<T, Brand extends string> = T & {
  readonly [brand]: { readonly [K in Brand]: true };
};

/** Stable identifier for a change, equivalent to branch name. */
export type ChangeID = Branded<string, "ChangeID">;
export const ChangeID = {
  schema: z.string().transform((s) => s as ChangeID),
};

/** Self-identified. Typically user's email. */
export type Username = Branded<string, "Username">;
export const Username = {
  schema: z.string().transform((s) => s as Username),
};

/** Identifier for a repository version. A commit hash. */
export type Revision = Branded<string, "Revision">;
export const Revision = {
  schema: z.string().transform((s) => s as Revision),
};

/** Repo-relative path. */
export type FilePath = Branded<string, "FilePath">;
export const FilePath = {
  schema: z.string().transform((s) => s as FilePath),
};

/** Repo-relative glob. */
export type FileGlob = Branded<string, "FileGlob">;

/** Node time resolution. Not comparable to git timestamps. */
export type TimestampMs = Branded<number, "TimestampMs">;
export const TimestampMs = {
  schema: z.number().transform((n) => n as TimestampMs),
};

/** A pair of revisions identifying a diff. */
export interface Span {
  readonly base: Revision;
  readonly tip: Revision;
}
export const Span = {
  schema: z.object({ base: Revision.schema, tip: Revision.schema }),
};

/** Change info stored in its log. */
export interface ChangeMeta {
  readonly id: ChangeID;
  readonly owners: ReadonlyArray<Username>;
  readonly parents: ReadonlyArray<ChangeID>;
  readonly brain: ReadonlyMap<Username, ReadonlyMap<FilePath, Span>>;
  // readonly name?: string;
  // readonly archived?: boolean;
  // TODO(jm): some sort of user marker/indicator
}

export type Base =
  | { readonly kind: "realized"; readonly rev: Revision } // single-parent
  | { readonly kind: "synthetic"; readonly revs: NontrivialReadonlyArray<Revision> }; // multi-parent merge

export interface Change extends ChangeMeta {
  readonly base: Base;
}
