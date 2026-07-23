import { type ChangeName, type FilePath, parseBranchName, parseFilePath, type UserName, userName } from "cabaret-core";

/**
 * A renderable page, addressed by the path of a `cabaret:` URI. Every page
 * reads — and acts — as the current user, or as `as` when set: how one
 * navigates around as another reviewer.
 *
 * Review and diff are parallel families: review pages show what the user
 * has left to read, while diff pages show the whole diff, base to tip,
 * blind to review state. Each family has a plural list page naming the
 * files and a singular per-file page showing one diff, so hosts can swap
 * between the two views of the same change or file.
 */
export type Page =
  | { readonly kind: "home"; readonly as?: UserName | undefined }
  | { readonly kind: "show"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | { readonly kind: "reviews"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | {
      readonly kind: "review";
      readonly change: ChangeName;
      readonly file: FilePath;
      readonly as?: UserName | undefined;
    }
  | { readonly kind: "diffs"; readonly change: ChangeName; readonly as?: UserName | undefined }
  | {
      readonly kind: "diff";
      readonly change: ChangeName;
      readonly file: FilePath;
      readonly as?: UserName | undefined;
    };

/**
 * The URI path denoting `page`. Inverse of `parsePagePath`. Every base path
 * sits under a `/cabaret/` root: VS Code assigns languages by file name
 * shape and cannot see a URI's scheme, so the root is what lets a filename
 * pattern claim diff pages for the cabaret grammar without risking real
 * files. A per-file page joins the change and the file with `:`, which no
 * ref name may contain, so the first `:` always ends the change even though
 * both parts can contain `/` — and the file keeps the path's last segment,
 * so a tab still wears the file's name. A borrowed identity wraps the whole
 * path as a leading `/as/<user>` segment, percent-encoded: a user name is
 * unconstrained, so nothing short of encoding keeps its `/`s out of the
 * path grammar.
 */
export function pagePath(page: Page): string {
  const base = ((): string => {
    switch (page.kind) {
      case "home":
        return "/cabaret/home";
      case "show":
        return `/cabaret/show/${page.change}`;
      case "reviews":
        return `/cabaret/reviews/${page.change}`;
      case "review":
        return `/cabaret/review/${page.change}:${page.file}`;
      case "diffs":
        return `/cabaret/diffs/${page.change}`;
      case "diff":
        return `/cabaret/diff/${page.change}:${page.file}`;
    }
  })();
  return page.as === undefined ? base : `/as/${encodeURIComponent(page.as)}${base}`;
}

/**
 * The page one level outside `page` — where stepping outside lands — or
 * undefined on home, the outermost page. A per-file page sits inside its
 * family's list page.
 */
export function enclosingPage(page: Page): Page | undefined {
  switch (page.kind) {
    case "home":
      return undefined;
    case "show":
      return { kind: "home", as: page.as };
    case "reviews":
    case "diffs":
      return { kind: "show", change: page.change, as: page.as };
    case "review":
      return { kind: "reviews", change: page.change, as: page.as };
    case "diff":
      return { kind: "diffs", change: page.change, as: page.as };
  }
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
  if (path === "/cabaret/home") {
    return { kind: "home" };
  }
  for (const kind of ["show", "reviews", "diffs"] as const) {
    const change = new RegExp(`^/cabaret/${kind}/(.+)$`).exec(path)?.[1];
    if (change !== undefined) {
      return { kind, change: parseBranchName(change) };
    }
  }
  // `[\s\S]` rather than `.` keeps the parse total: a file path (unlike a
  // ref name) is not barred from containing newlines, even though the doc
  // layer will refuse to render one.
  for (const kind of ["review", "diff"] as const) {
    const split = new RegExp(`^/cabaret/${kind}/([^:]+):([\\s\\S]+)$`).exec(path);
    if (split?.[1] !== undefined && split[2] !== undefined) {
      return { kind, change: parseBranchName(split[1]), file: parseFilePath(split[2]) };
    }
  }
  throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
}
