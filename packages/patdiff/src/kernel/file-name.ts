export type FileName =
  | { readonly kind: "Real"; readonly realName: string; readonly altName?: string }
  | { readonly kind: "Fake"; readonly name: string };

export const real = (realName: string, altName?: string): FileName =>
  altName === undefined ? { kind: "Real", realName } : { kind: "Real", realName, altName };

export const fake = (name: string): FileName => ({ kind: "Fake", name });

export const realNameExn = (t: FileName): string => {
  if (t.kind === "Fake") {
    throw new Error("File_name.realNameExn got a fake file");
  }
  return t.realName;
};

export const displayName = (t: FileName): string => {
  switch (t.kind) {
    case "Real":
      return t.altName ?? t.realName;
    case "Fake":
      return t.name;
  }
};

export const toStringHum = displayName;

// Slash-joining rather than node:path keeps this module portable to the
// browser; the names here are diff labels, never real filesystem paths.
const join = (base: string, part: string): string => (base === "" ? part : `${base.replace(/\/+$/, "")}/${part}`);

export const append = (t: FileName, part: string): FileName => {
  switch (t.kind) {
    case "Real":
      return t.altName === undefined
        ? { kind: "Real", realName: join(t.realName, part) }
        : {
            kind: "Real",
            realName: join(t.realName, part),
            altName: join(t.altName, part),
          };
    case "Fake":
      return { kind: "Fake", name: join(t.name, part) };
  }
};

export const devNull: FileName = { kind: "Real", realName: "/dev/null" };

export const equal = (a: FileName, b: FileName): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "Fake" && b.kind === "Fake") return a.name === b.name;
  if (a.kind === "Real" && b.kind === "Real") {
    return a.realName === b.realName && a.altName === b.altName;
  }
  return false;
};
