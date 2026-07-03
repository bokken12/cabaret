/** Helpers for translating OCaml `patdiff` library tests.
 *
 *  OCaml's tests pipe the patdiff CLI through `ansi_text visualize -minimize`,
 *  which yields a stable, human-readable text representation of the ANSI
 *  escapes (e.g. `(fg:red)`, `(bg:gray fg:black)`).
 *
 *  Here we run [withNodeIoCompare.diffStrings] directly and then pass the
 *  result through [visualize(minimize(...))]. This mirrors the OCaml pipeline
 *  without needing to spawn subprocesses. */

import * as AnsiText from "../../ansi-text/ansi-text.js";
import type { Configuration } from "../../kernel/configuration.js";
import * as Patdiff from "../../lib/patdiff.js";
import * as Percent from "../../shared/percent.js";

export type PatdiffArgs = {
  readonly prev: string;
  readonly next: string;
  readonly extraFlags?: ReadonlyArray<string | readonly [string, string]>;
  /** If true, do not strip the "Unclean exit" trailer that OCaml prints. */
  readonly keepUncleanExit?: boolean;
};

/** Convert flag list into a partial [Configuration] override.
 *
 *  Only the flags actually used by the translated tests are handled. */
const applyFlags = (
  base: Configuration,
  extraFlags: ReadonlyArray<string | readonly [string, string]>,
): Configuration => {
  const overrides: Parameters<typeof Patdiff.Configuration.override>[1] = {};
  let i = 0;
  // Normalize: turn tuple [k, v] entries into two consecutive elements.
  const flat: string[] = [];
  for (const f of extraFlags) {
    if (typeof f === "string") flat.push(f);
    else {
      flat.push(f[0], f[1]);
    }
  }
  while (i < flat.length) {
    const flag = flat[i]!;
    switch (flag) {
      case "-ascii":
        overrides.output = "Ascii";
        overrides.unrefined = true;
        i += 1;
        break;
      case "-unrefined":
        overrides.unrefined = true;
        i += 1;
        break;
      case "-keep-whitespace":
        overrides.keepWs = true;
        i += 1;
        break;
      case "-no-semantic-cleanup":
        // [no-semantic-cleanup] => big-enoughs = 1.
        overrides.lineBigEnough = 1;
        overrides.wordBigEnough = 1;
        i += 1;
        break;
      case "-split-long-lines":
        overrides.splitLongLines = true;
        i += 1;
        break;
      case "-find-moves":
        overrides.findMoves = true;
        i += 1;
        break;
      case "-html":
        overrides.output = "Html";
        overrides.unrefined = true;
        i += 1;
        break;
      case "-float-tol":
      case "-float-tolerance": {
        const val = flat[i + 1];
        if (val === undefined) throw new Error("missing -float-tolerance value");
        overrides.floatTolerance = Percent.parse(val);
        i += 2;
        break;
      }
      case "-location-style": {
        const val = flat[i + 1];
        if (val === undefined) throw new Error("missing -location-style value");
        switch (val) {
          case "diff":
            overrides.locationStyle = "Diff";
            break;
          case "omake":
            overrides.locationStyle = "Omake";
            break;
          case "none":
            overrides.locationStyle = "None";
            break;
          default:
            throw new Error(`unknown location-style: ${val}`);
        }
        i += 2;
        break;
      }
      case "-context": {
        const val = flat[i + 1];
        if (val === undefined) throw new Error("missing -context value");
        overrides.context = Number(val);
        i += 2;
        break;
      }
      default:
        throw new Error(`unsupported flag in patdiff helper: ${flag}`);
    }
  }
  return Patdiff.Configuration.override(base, overrides);
};

/** Run a diff and return the OCaml-style visualized output, including the
 *  trailing `("Unclean exit" ...)` line that OCaml prints when the diff is
 *  non-empty (mirroring the `patdiff_dir` helper in OCaml's test/import.ml). */
export const patdiff = (args: PatdiffArgs): string => {
  const config = applyFlags(Patdiff.Configuration.defaultConfiguration, args.extraFlags ?? []);
  const result = Patdiff.CompareCore.withNodeIoCompare.diffStrings({
    config,
    printGlobalHeader: true,
    prev: { name: "prev/file", text: args.prev },
    next: { name: "next/file", text: args.next },
  });
  if (result.kind === "Same") return "";
  let value = result.value;
  // Apply visualize/minimize (matches OCaml `ansi_text visualize -minimize`)
  // only when output is ANSI; for Ascii/Html output the raw text is what we want.
  if (config.output === "Ansi") {
    value = AnsiText.visualize(AnsiText.minimize(value));
  }
  if (!value.endsWith("\n")) value += "\n";
  if (args.keepUncleanExit === false) return value;
  // The OCaml CLI exits 1 on diff, and `system` reports `Unclean exit`. Mimic.
  return value + '("Unclean exit" (Exit_non_zero 1))\n';
};

/** Same as [patdiff] but allows specifying multiple files in "prev/" and
 *  "next/" directories. Used by [test_exclude_include]. */
export type PatdiffDirArgs = {
  readonly prev: ReadonlyArray<readonly [string, string]>;
  readonly next: ReadonlyArray<readonly [string, string]>;
  readonly extraFlags?: ReadonlyArray<string | readonly [string, string]>;
};

/** Compute the list of [prev/X next/X] pairs that pass through include/exclude
 *  filters, then call [patdiff] for each one in sorted order. */
export const patdiffDir = (args: PatdiffDirArgs): string => {
  const flat: string[] = [];
  const includes: string[] = [];
  const excludes: string[] = [];
  const remaining: string[] = [];
  const inputFlags = args.extraFlags ?? [];
  // Flatten to strings.
  for (const f of inputFlags) {
    if (typeof f === "string") flat.push(f);
    else flat.push(f[0], f[1]);
  }
  let i = 0;
  while (i < flat.length) {
    const flag = flat[i]!;
    if (flag === "-include") {
      const val = flat[i + 1];
      if (val === undefined) throw new Error("missing -include value");
      includes.push(val);
      i += 2;
    } else if (flag === "-exclude") {
      const val = flat[i + 1];
      if (val === undefined) throw new Error("missing -exclude value");
      excludes.push(val);
      i += 2;
    } else {
      remaining.push(flag);
      i += 1;
    }
  }
  // Build maps.
  const prevMap = new Map(args.prev.map(([k, v]) => [k, v]));
  const nextMap = new Map(args.next.map(([k, v]) => [k, v]));
  // Intersection of names, sorted.
  const allNames = new Set<string>();
  for (const [k] of args.prev) allNames.add(k);
  for (const [k] of args.next) allNames.add(k);
  const filter = (name: string): boolean => {
    if (includes.length > 0) {
      const ok = includes.some((re) => new RegExp(re).test(name));
      if (!ok) return false;
    }
    for (const ex of excludes) if (new RegExp(ex).test(name)) return false;
    return true;
  };
  const inter = [...allNames].filter((n) => prevMap.has(n) && nextMap.has(n));
  inter.sort();
  let out = "";
  for (const name of inter) {
    if (!filter(name)) continue;
    const prev = prevMap.get(name)!;
    const next = nextMap.get(name)!;
    const config = applyFlags(Patdiff.Configuration.defaultConfiguration, remaining as ReadonlyArray<string>);
    const r = Patdiff.CompareCore.withNodeIoCompare.diffStrings({
      config,
      printGlobalHeader: true,
      prev: { name: `prev/${name}`, text: prev },
      next: { name: `next/${name}`, text: next },
    });
    if (r.kind === "Same") continue;
    let value = r.value;
    if (config.output === "Ansi") {
      value = AnsiText.visualize(AnsiText.minimize(value));
    }
    if (!value.endsWith("\n")) value += "\n";
    out += value;
  }
  if (out.length === 0) return "";
  return out + '("Unclean exit" (Exit_non_zero 1))\n';
};
