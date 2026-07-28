declare const brand: unique symbol;

export type Branded<T, Brand extends string> = T & {
  readonly [brand]: { readonly [K in Brand]: true };
};

/** Stable identifier for a change, equivalent to branch name. */
export type ChangeID = Branded<string, "ChangeID">;

/** Self-identified. Typically user's email. */
export type Username = Branded<string, "Username">;

/** Identifier for a repository version. A commit hash. */
export type Revision = Branded<string, "Revision">;

/** Repo-relative path. */
export type FilePath = Branded<string, "FilePath">;

/** Repo-relative glob. */
export type FileGlob = Branded<string, "FileGlob">;

/** Not comparable to git timestamps. */
export type TimestampMs = Branded<number, "TimestampMs">;

/**  */
export interface Change {
  readonly id: string;
  readonly name?: string;
  readonly owner?: Username;
  readonly base?: Revision;
  readonly archived?: boolean;
}
