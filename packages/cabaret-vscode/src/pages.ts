import { parseRefName, type RefName } from "cabaret-core";

/** A renderable page, addressed by the path of a `cabaret:` URI. */
export type Page = { readonly kind: "todo" } | { readonly kind: "show"; readonly change: RefName };

/** The URI path denoting `page`. Inverse of `parsePagePath`. */
export function pagePath(page: Page): string {
  return page.kind === "todo" ? "/todo" : `/show/${page.change}`;
}

/** The page a `cabaret:` URI path denotes. Inverse of `pagePath`. */
export function parsePagePath(path: string): Page {
  if (path === "/todo") {
    return { kind: "todo" };
  }
  const change = /^\/show\/(.+)$/.exec(path)?.[1];
  if (change === undefined) {
    throw new Error(`not a cabaret page: ${JSON.stringify(path)}`);
  }
  return { kind: "show", change: parseRefName(change) };
}
