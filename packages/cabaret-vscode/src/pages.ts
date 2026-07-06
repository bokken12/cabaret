import { type FilePath, parseFilePath, parseRefName, type RefName } from "cabaret-core";

/** A renderable page, addressed by the path of a `cabaret:` URI. */
export type Page =
  | { readonly kind: "todo" }
  | { readonly kind: "show"; readonly change: RefName }
  | { readonly kind: "review"; readonly change: RefName }
  | { readonly kind: "diff"; readonly change: RefName; readonly file: FilePath };

/**
 * The URI path denoting `page`. Inverse of `parsePagePath`. A diff path joins
 * the change and the file with `:`, which no ref name may contain, so the
 * first `:` always ends the change even though both parts can contain `/`.
 */
export function pagePath(page: Page): string {
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
}

/** The page a `cabaret:` URI path denotes. Inverse of `pagePath`. */
export function parsePagePath(path: string): Page {
  if (path === "/todo") {
    return { kind: "todo" };
  }
  const show = /^\/show\/(.+)$/.exec(path)?.[1];
  if (show !== undefined) {
    return { kind: "show", change: parseRefName(show) };
  }
  const review = /^\/review\/(.+)$/.exec(path)?.[1];
  if (review !== undefined) {
    return { kind: "review", change: parseRefName(review) };
  }
  // `[\s\S]` rather than `.` keeps the parse total: a file path (unlike a
  // ref name) is not barred from containing newlines, even though the doc
  // layer will refuse to render one.
  const diff = /^\/diff\/([^:]+):([\s\S]+)$/.exec(path);
  if (diff?.[1] !== undefined && diff[2] !== undefined) {
    return { kind: "diff", change: parseRefName(diff[1]), file: parseFilePath(diff[2]) };
  }
  throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
}
