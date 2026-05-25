/**
 * Core domain types.
 *
 * Branded primitives prevent accidental mixing of structurally identical
 * strings/numbers (a BlobSha is not interchangeable with a CommitSha or an
 * arbitrary string). Constructors live alongside their types; runtime
 * validation belongs at I/O boundaries (e.g. parsing git output) and lives
 * in the `backend` package.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type BlobSha = Brand<string, 'BlobSha'>;
export type CommitSha = Brand<string, 'CommitSha'>;
export type Path = Brand<string, 'Path'>;
export type PrNumber = Brand<number, 'PrNumber'>;
export type UserId = Brand<string, 'UserId'>;
/** Epoch milliseconds. */
export type Timestamp = Brand<number, 'Timestamp'>;

export const BlobSha = (s: string): BlobSha => s as BlobSha;
export const CommitSha = (s: string): CommitSha => s as CommitSha;
export const Path = (s: string): Path => s as Path;
export const PrNumber = (n: number): PrNumber => n as PrNumber;
export const UserId = (s: string): UserId => s as UserId;
export const Timestamp = (n: number): Timestamp => n as Timestamp;

/**
 * How a brain entry was advanced.
 *
 * - `user`: the reviewer explicitly accepted this state.
 * - `internal`: the brain advanced without a human looking (e.g. a rev-update
 *   after a rebase that didn't change the file's contribution). Iron calls
 *   this `Internal__fully_reviewed` and uses the distinction for catch-up.
 */
export type MarkKind = 'user' | 'internal';

/**
 * The state of one file in a PR (current PR view) or in a reviewer's brain
 * (what they last saw). `baseBlob` is `null` for files added by the PR
 * (i.e. absent from the merge-base tree). `tipBlob` is always present;
 * deletions are not yet modeled. TODO: extend to handle deletes and
 * renames.
 */
export type FileState = {
  readonly path: Path;
  readonly baseBlob: BlobSha | null;
  readonly tipBlob: BlobSha;
};

/**
 * A single per-(user, PR, path) review state. The `(baseBlob, tipBlob)`
 * pair is the diff the reviewer last accepted; content addressing makes
 * comparisons against the PR's current pair survive rebases and
 * force-pushes.
 *
 * `lastModifiedAt` records when this entry was last advanced; set by
 * whoever produces the entry (e.g. `markReviewed`), never inferred. The
 * field is carried per-entry so cross-device sync can tie-break advances
 * of the same path without needing a separate history mechanism.
 */
export type BrainEntry = FileState & {
  readonly markKind: MarkKind;
  readonly lastModifiedAt: Timestamp;
};

/**
 * A user's review state for one PR. The entries map is keyed by path; each
 * file's state is independent of every other file's.
 */
export type Brain = {
  readonly user: UserId;
  readonly pr: PrNumber;
  readonly entries: ReadonlyMap<Path, BrainEntry>;
};

/**
 * The diff from base to tip for one file. Same shape as FileState; named
 * separately so signatures that *mean* "a base→tip diff" read clearly.
 */
export type Diff2 = FileState;

/**
 * A diamond: the change between `(oldBase, oldTip)` (what the reviewer
 * accepted) and `(newBase, newTip)` (what the PR now presents). This is
 * the unit cabaret renders to a reviewer when the brain doesn't already
 * match the PR's current state for a file.
 */
export type Diff4 = {
  readonly path: Path;
  readonly oldBase: BlobSha | null;
  readonly oldTip: BlobSha;
  readonly newBase: BlobSha | null;
  readonly newTip: BlobSha;
};

/**
 * The classification of a single file in a PR with respect to a reviewer's
 * brain. Discriminated union — exhaustive `switch` on `kind` is the
 * intended consumption pattern.
 *
 * - `reviewed`: brain entry equals the PR's current `(base, tip)`. Nothing
 *   else is needed.
 * - `unreviewed`: the brain has no entry for this path. `current` carries
 *   the PR's view of the file so callers can show the full diff.
 * - `revUpdate`: the brain entry's tip blob matches the PR's, but the base
 *   moved. Callers can advance the brain silently. `current` and
 *   `previous` are both available so callers can record the auto-advance
 *   or derive a `Diff4` via `diff4FromBrain`.
 * - `stale`: the brain has an entry but the PR has moved meaningfully.
 *   Callers should render a diff-of-diffs between `previous` and `current`
 *   (see `diff4FromBrain`).
 */
export type FileStatus =
  | { readonly kind: 'reviewed'; readonly path: Path }
  | { readonly kind: 'unreviewed'; readonly path: Path; readonly current: FileState }
  | {
      readonly kind: 'revUpdate';
      readonly path: Path;
      readonly current: FileState;
      readonly previous: BrainEntry;
    }
  | {
      readonly kind: 'stale';
      readonly path: Path;
      readonly current: FileState;
      readonly previous: BrainEntry;
    };
