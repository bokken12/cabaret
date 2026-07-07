import { type FilePath, parseFilePath, parseRefName, type RefName } from "cabaret-core";

/** One side of a file's pending diff, in patdiff's vocabulary. */
export type Side = "prev" | "next";

/** What a `cabaret-rev:` URI serves: one side of `file`'s pending diff in `change`. */
export interface Rev {
  readonly side: Side;
  readonly change: RefName;
  readonly file: FilePath;
}

/**
 * The URI path denoting `rev`. Inverse of `parseRevPath`. The change and file
 * join with `:` as diff page paths do, and the path ends with the file so
 * editors infer its language.
 */
export function revPath(rev: Rev): string {
  return `/${rev.side}/${rev.change}:${rev.file}`;
}

/** The rev a `cabaret-rev:` URI path denotes. Inverse of `revPath`. */
export function parseRevPath(path: string): Rev {
  // `[\s\S]` keeps the parse total over file paths, as in parsePagePath.
  const match = /^\/(prev|next)\/([^:]+):([\s\S]+)$/.exec(path);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`not a cabaret rev: ${JSON.stringify(path)}`);
  }
  return { side: match[1] as Side, change: parseRefName(match[2]), file: parseFilePath(match[3]) };
}
