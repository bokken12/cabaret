import { type Page, pagePath, parsePagePath } from "cabaret-views";

/** The fragment of `href`, `#` included; empty when there is none. Reading
 * `location.hash` directly would not do: Firefox percent-decodes it. */
export function currentHash(href: string): string {
  const at = href.indexOf("#");
  return at === -1 ? "" : href.slice(at);
}

/** The page a location hash denotes; an empty hash is home, the landing page. */
export function pageFromHash(hash: string): Page {
  const path = hash.replace(/^#/, "");
  if (path === "" || path === "/") {
    return { kind: "home" };
  }
  return parsePagePath(path.split("/").map(decodeURIComponent).join("/"));
}

/**
 * The location hash denoting `page`. Inverse of `pageFromHash`. Each path
 * segment is percent-encoded, so file and change names survive characters
 * the URL would otherwise claim (`%`, `#`, spaces). The page path's own
 * percent-encoding (the `/as/` segment) layers underneath and gets encoded
 * again here; each layer decodes exactly once, so the round-trip is exact.
 */
export function pageHash(page: Page): string {
  return `#${pagePath(page).split("/").map(encodeURIComponent).join("/")}`;
}
