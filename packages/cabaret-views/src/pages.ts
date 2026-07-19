import { type ChangeName, type FilePath, parseBranchName, parseFilePath, type UserName, userName } from "cabaret-core";

/**
 * A renderable page, addressed by the path of a `cabaret:` URI. Review and
 * diff pages read the current user's review state, or `as`'s when set — how
 * a show page's remaining-review rows open another reviewer's view.
 */
export type Page =
  | { readonly kind: "todo" }
  | { readonly kind: "show"; readonly change: ChangeName }
  | { readonly kind: "review"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | { readonly kind: "diffs"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | { readonly kind: "diff"; readonly change: ChangeName; readonly file: FilePath; readonly as?: UserName | undefined };

/**
 * The URI path denoting `page`. Inverse of `parsePagePath`. Every path sits
 * under a `/cabaret/` root: VS Code assigns languages by file name shape and
 * cannot see a URI's scheme, so the root is what lets a filename pattern
 * claim diff pages for the cabaret grammar without risking real files. A
 * diff path joins the change and the file with `:`, which no ref name may
 * contain, so the first `:` always ends the change even though both parts
 * can contain `/` — and the file keeps the path's last segment, so a tab
 * still wears the file's name. An as-page's user rides its own
 * percent-encoded segment ahead of the change: a user name is
 * unconstrained, so nothing short of encoding keeps its `/`s out of the
 * path grammar.
 */
export function pagePath(page: Page): string {
  switch (page.kind) {
    case "todo":
      return "/cabaret/todo";
    case "show":
      return `/cabaret/show/${page.change}`;
    case "review":
      return page.as === undefined
        ? `/cabaret/review/${page.change}`
        : `/cabaret/review-as/${encodeURIComponent(page.as)}/${page.change}`;
    case "diffs":
      return page.as === undefined
        ? `/cabaret/diffs/${page.change}`
        : `/cabaret/diffs-as/${encodeURIComponent(page.as)}/${page.change}`;
    case "diff":
      return page.as === undefined
        ? `/cabaret/diff/${page.change}:${page.file}`
        : `/cabaret/diff-as/${encodeURIComponent(page.as)}/${page.change}:${page.file}`;
  }
}

/** The page a `cabaret:` URI path denotes. Inverse of `pagePath`. */
export function parsePagePath(path: string): Page {
  if (path === "/cabaret/todo") {
    return { kind: "todo" };
  }
  const show = /^\/cabaret\/show\/(.+)$/.exec(path)?.[1];
  if (show !== undefined) {
    return { kind: "show", change: parseBranchName(show) };
  }
  const review = /^\/cabaret\/review\/(.+)$/.exec(path)?.[1];
  if (review !== undefined) {
    return { kind: "review", change: parseBranchName(review) };
  }
  const reviewAs = /^\/cabaret\/review-as\/([^/]+)\/(.+)$/.exec(path);
  if (reviewAs?.[1] !== undefined && reviewAs[2] !== undefined) {
    return { kind: "review", change: parseBranchName(reviewAs[2]), as: userName(decodeURIComponent(reviewAs[1])) };
  }
  const diffs = /^\/cabaret\/diffs\/(.+)$/.exec(path)?.[1];
  if (diffs !== undefined) {
    return { kind: "diffs", change: parseBranchName(diffs) };
  }
  const diffsAs = /^\/cabaret\/diffs-as\/([^/]+)\/(.+)$/.exec(path);
  if (diffsAs?.[1] !== undefined && diffsAs[2] !== undefined) {
    return { kind: "diffs", change: parseBranchName(diffsAs[2]), as: userName(decodeURIComponent(diffsAs[1])) };
  }
  // `[\s\S]` rather than `.` keeps the parse total: a file path (unlike a
  // ref name) is not barred from containing newlines, even though the doc
  // layer will refuse to render one.
  const diff = /^\/cabaret\/diff\/([^:]+):([\s\S]+)$/.exec(path);
  if (diff?.[1] !== undefined && diff[2] !== undefined) {
    return { kind: "diff", change: parseBranchName(diff[1]), file: parseFilePath(diff[2]) };
  }
  const diffAs = /^\/cabaret\/diff-as\/([^/]+)\/([^:]+):([\s\S]+)$/.exec(path);
  if (diffAs?.[1] !== undefined && diffAs[2] !== undefined && diffAs[3] !== undefined) {
    return {
      kind: "diff",
      change: parseBranchName(diffAs[2]),
      file: parseFilePath(diffAs[3]),
      as: userName(decodeURIComponent(diffAs[1])),
    };
  }
  throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
}
