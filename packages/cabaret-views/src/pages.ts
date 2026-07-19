import { type ChangeName, type FilePath, parseBranchName, parseFilePath, type UserName, userName } from "cabaret-core";

/**
 * A renderable page, addressed by the path of a `cabaret:` URI. Every page
 * reads — and acts — as the current user, or as `as` when set: how one
 * navigates around as another reviewer.
 */
export type Page =
  | { readonly kind: "todo"; readonly as?: UserName | undefined }
  | { readonly kind: "show"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | { readonly kind: "review"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | { readonly kind: "diff"; readonly change: ChangeName; readonly file: FilePath; readonly as?: UserName | undefined };

/**
 * The URI path denoting `page`. Inverse of `parsePagePath`. A diff path joins
 * the change and the file with `:`, which no ref name may contain, so the
 * first `:` always ends the change even though both parts can contain `/`.
 * A borrowed identity wraps the whole path as a leading `/as/<user>` segment,
 * percent-encoded: a user name is unconstrained, so nothing short of encoding
 * keeps its `/`s out of the path grammar.
 */
export function pagePath(page: Page): string {
  const base = ((): string => {
    switch (page.kind) {
      case "todo":
        return "/todo";
      case "show":
        return `/show/${page.change}`;
      case "review":
        return `/review/${page.change}`;
      case "diff":
        return `/diff/${page.change}:${page.file}`;
    }
  })();
  return page.as === undefined ? base : `/as/${encodeURIComponent(page.as)}${base}`;
}

/** The page a `cabaret:` URI path denotes. Inverse of `pagePath`. */
export function parsePagePath(path: string): Page {
  const as = /^\/as\/([^/]+)(\/[\s\S]+)$/.exec(path);
  if (as?.[1] !== undefined && as[2] !== undefined) {
    const inner = parsePagePath(as[2]);
    // One identity per page: a nested `/as/` segment addresses nothing.
    if (inner.as !== undefined) {
      throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
    }
    return { ...inner, as: userName(decodeURIComponent(as[1])) };
  }
  if (path === "/todo") {
    return { kind: "todo" };
  }
  const show = /^\/show\/(.+)$/.exec(path)?.[1];
  if (show !== undefined) {
    return { kind: "show", change: parseBranchName(show) };
  }
  const review = /^\/review\/(.+)$/.exec(path)?.[1];
  if (review !== undefined) {
    return { kind: "review", change: parseBranchName(review) };
  }
  // `[\s\S]` rather than `.` keeps the parse total: a file path (unlike a
  // ref name) is not barred from containing newlines, even though the doc
  // layer will refuse to render one.
  const diff = /^\/diff\/([^:]+):([\s\S]+)$/.exec(path);
  if (diff?.[1] !== undefined && diff[2] !== undefined) {
    return { kind: "diff", change: parseBranchName(diff[1]), file: parseFilePath(diff[2]) };
  }
  throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
}
