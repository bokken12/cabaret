import type { DiffInput } from "./diff-input.js";

const looksLikePythonFilename = (name: string): boolean => name.endsWith(".py");

const looksLikePythonFirstLine = (firstLine: string): boolean =>
  firstLine.startsWith("#!") && firstLine.includes("python");

const looksLikePython = <I>(input: I, getName: (i: I) => string, getFirstLine: (i: I) => string): boolean =>
  looksLikePythonFilename(getName(input)) || looksLikePythonFirstLine(getFirstLine(input));

const fsharpSuffixes: readonly string[] = (() => {
  const nonBase = "iylx";
  const base = ".fs";
  const out: string[] = [base];
  for (const c of nonBase) out.push(base + c);
  return out;
})();

const looksLikeFsharpFilename = (filename: string): boolean => fsharpSuffixes.some((s) => filename.endsWith(s));

const looksLikeFsharp = <I>(input: I, getName: (i: I) => string, _getFirstLine: (i: I) => string): boolean =>
  looksLikeFsharpFilename(getName(input));

const forDiffInternal = <I>(args: {
  prev: I;
  next: I;
  getName: (i: I) => string;
  getFirstLine: (i: I) => string;
}): boolean => {
  const { prev, next, getName, getFirstLine } = args;
  const fns = [looksLikePython, looksLikeFsharp];
  for (const f of fns) {
    for (const input of [prev, next]) {
      if (f(input, getName, getFirstLine)) return true;
    }
  }
  return false;
};

export const forDiff = (args: { prev: DiffInput; next: DiffInput }): boolean =>
  forDiffInternal({
    prev: args.prev,
    next: args.next,
    getName: (i) => i.name,
    getFirstLine: (i) => {
      const idx = i.text.indexOf("\n");
      return idx === -1 ? i.text : i.text.slice(0, idx);
    },
  });

export const forDiffArray = (args: {
  prev: readonly [string, readonly string[]];
  next: readonly [string, readonly string[]];
}): boolean =>
  forDiffInternal({
    prev: args.prev,
    next: args.next,
    getName: ([name]) => name,
    getFirstLine: ([, lines]) => (lines.length === 0 ? "" : lines[0]!),
  });
