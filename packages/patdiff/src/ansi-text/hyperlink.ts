export type T = { readonly kind: "Start"; readonly url: string } | { readonly kind: "End" };

export const Start = (url: string): T => ({ kind: "Start", url });
export const End: T = { kind: "End" };

export const toString = (t: T): string => {
  switch (t.kind) {
    case "End":
      return "\x1b]8;;\x1b\\";
    case "Start":
      return `\x1b]8;;${t.url}\x1b\\`;
  }
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Start":
      return `(HREF:${t.url})`;
    case "End":
      return "(/HREF)";
  }
};

export const equal = (a: T, b: T): boolean => {
  if (a.kind === "End" && b.kind === "End") return true;
  if (a.kind === "Start" && b.kind === "Start") return a.url === b.url;
  return false;
};
