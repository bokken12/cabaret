/** Tests for [expect_test_patdiff]. Translated from
 *  [patdiff/expect-test-patdiff/test/test_diff_printer.ml] and
 *  [.../test_expect_test_patdiff.ml].
 *
 *  Deviations from the OCaml originals:
 *
 *  - OCaml uses [print_s] (= [Sexp.to_string_hum]) which is a column-aligning
 *    multi-line pretty printer. The TS port uses [printSexp] from
 *    [shared/sexp.ts], which is single-line. As a result, the *layout* of
 *    sexp-based diff outputs differs from the OCaml ones - but the diff
 *    *behavior* (what hunks are produced, where) is the same. Test snapshots
 *    reflect the TS layout.
 *
 *  - In OCaml the [diff_printer] / [print_patdiff] functions write to stdout
 *    and [%expect.output] reads it back. We capture [process.stdout.write] in
 *    a [Capture] helper and then assert against the captured string. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atom, list, type Sexp } from "../shared/sexp.js";
import {
  diffPrinter,
  diffPrinterS,
  diffToString,
  patdiff,
  patdiffS,
  printPatdiff,
  printPatdiffS,
} from "./expect-test-patdiff.js";

// ---------- stdout capture helper ----------

class Capture {
  private chunks: string[] = [];
  private original!: typeof process.stdout.write;

  start(): void {
    this.chunks = [];
    this.original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  }

  stop(): void {
    process.stdout.write = this.original;
  }

  read(): string {
    const out = this.chunks.join("");
    this.chunks = [];
    return out;
  }
}

let capture: Capture;
beforeEach(() => {
  capture = new Capture();
  capture.start();
});
afterEach(() => {
  capture.stop();
});

// ---------- shared fixtures ----------

const strings = "zero one two three".split(" ");
const sortedStrings = [...strings].sort();
const string1 = strings.join("\n");
const string2 = sortedStrings.join("\n");

/** Construct an int->int "map" sexp as a list of (k v) pairs - the same shape
 *  produced by OCaml's [%sexp (m : int Int.Map.t)] for sorted-int-keyed maps. */
const intMapSexp = (entries: readonly (readonly [number, number])[]): Sexp =>
  list(entries.map(([k, v]) => list([atom(String(k)), atom(String(v))])));

const defaultEntries: (readonly [number, number])[] = Array.from({ length: 20 }, (_, i): readonly [number, number] => [
  i + 1,
  (i + 1) * 100,
]);

// ---------- translated from test_expect_test_patdiff.ml ----------

describe("printPatdiff", () => {
  it("prints nothing when strings are identical", () => {
    printPatdiff({}, string1, string1);
    expect(capture.read()).toBe("");
    printPatdiff({}, string2, string2);
    expect(capture.read()).toBe("");
  });

  it("prints a diff when strings differ", () => {
    printPatdiff({}, string1, string2);
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|zero
        one
      +|three
        two
      -|three
      +|zero
      "
    `);
  });

  it("respects the [context] option", () => {
    printPatdiff({ context: 0 }, string2, string1);
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      +|zero
      === DIFF HUNK ===
      +|two
      === DIFF HUNK ===
      -|two
      -|zero
      "
    `);
  });
});

describe("printPatdiff newline behavior", () => {
  it("non-empty diff ends with a newline", () => {
    process.stdout.write("----------\n");
    printPatdiff({}, "cat", "dog");
    process.stdout.write("----------\n");
    expect(capture.read()).toMatchInlineSnapshot(`
      "----------
      === DIFF HUNK ===
      -|cat
      +|dog
      ----------
      "
    `);
  });

  it("empty diff does not print a newline", () => {
    process.stdout.write("----------\n");
    printPatdiff({}, "cat", "cat");
    process.stdout.write("----------\n");
    expect(capture.read()).toMatchInlineSnapshot(`
      "----------
      ----------
      "
    `);
  });
});

// ---------- sexp variant ----------

// Simple tree-shaped sexp, similar to OCaml's [Node { left; key; right }]
// records, but produced manually rather than via ppx_sexp_conv. Each "node"
// is rendered as: (Node (left ...) (key ...) (right ...)).
const node = (left: Sexp, key: string, right: Sexp): Sexp =>
  list([atom("Node"), list([atom("left"), left]), list([atom("key"), atom(key)]), list([atom("right"), right])]);

const leaf = atom("Leaf");

const sexp1: Sexp = node(leaf, "one", node(leaf, "two", node(leaf, "three", leaf)));

const sexp2: Sexp = node(node(node(leaf, "one", leaf), "two", leaf), "three", leaf);

describe("printPatdiffS", () => {
  it("prints nothing for identical sexps", () => {
    printPatdiffS({}, sexp1, sexp1);
    expect(capture.read()).toBe("");
    printPatdiffS({}, sexp2, sexp2);
    expect(capture.read()).toBe("");
  });

  // The OCaml original here exercises [Sexp.to_string_hum]'s multi-line
  // layout. Our single-line [printSexp] produces a single long line, so the
  // diff is also single-line. We still snapshot the exact output for
  // fidelity - both implementations produce a single-hunk replacement, and
  // the line content is the canonical (single-line) sexp form.
  it("produces a single-hunk replace diff for differing sexps", () => {
    printPatdiffS({}, sexp1, sexp2);
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|(Node (left Leaf) (key one) (right (Node (left Leaf) (key two) (right (Node (left Leaf) (key three) (right Leaf))))))
      +|(Node (left (Node (left (Node (left Leaf) (key one) (right Leaf))) (key two) (right Leaf))) (key three) (right Leaf))
      "
    `);
  });
});

// ---------- translated from test_diff_printer.ml ----------

describe("diffPrinter", () => {
  it("first call prints the full string; subsequent calls print diffs", () => {
    const entries: (readonly [number, number])[] = [...defaultEntries];
    const m1 = JSON.stringify(entries);
    const print = diffPrinter({ context: 1 }, m1);
    expect(capture.read()).toMatchInlineSnapshot(
      `
      "[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,1000],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      "
    `,
    );

    const entries2 = entries.map((p): readonly [number, number] => (p[0] === 10 ? [10, 999] : p));
    print(JSON.stringify(entries2));
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,1000],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      +|[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,999],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      "
    `);

    const entries3: (readonly [number, number])[] = [[0, -1], ...entries2];
    print(JSON.stringify(entries3));
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,999],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      +|[[0,-1],[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,999],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      "
    `);
  });

  it("passing null/undefined as [initial] delays the first print", () => {
    const print = diffPrinter({ context: 1 }, null);
    // No initial print:
    expect(capture.read()).toBe("");

    const entries: (readonly [number, number])[] = [...defaultEntries];
    print(JSON.stringify(entries));
    // First call - prints the full input as the seed:
    expect(capture.read()).toMatchInlineSnapshot(
      `
      "[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,1000],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      "
    `,
    );

    const entries2 = entries.map((p): readonly [number, number] => (p[0] === 10 ? [10, 999] : p));
    print(JSON.stringify(entries2));
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,1000],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      +|[[1,100],[2,200],[3,300],[4,400],[5,500],[6,600],[7,700],[8,800],[9,900],[10,999],[11,1100],[12,1200],[13,1300],[14,1400],[15,1500],[16,1600],[17,1700],[18,1800],[19,1900],[20,2000]]
      "
    `);
  });

  it("uses one line of context with multi-line input", () => {
    // Use newline-separated strings so context truly hides untouched lines.
    const initial = defaultEntries.map(([k, v]) => `${k} -> ${v}`).join("\n");
    const print = diffPrinter({ context: 1 }, initial);
    capture.read(); // discard the initial full print

    const changed = defaultEntries.map(([k, v]) => (k === 10 ? `10 -> 999` : `${k} -> ${v}`)).join("\n");
    print(changed);
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
        9 -> 900
      -|10 -> 1000
      +|10 -> 999
        11 -> 1100
      "
    `);
  });
});

describe("diffPrinterS", () => {
  it("first call prints the full sexp; subsequent calls print diffs", () => {
    const m1 = intMapSexp(defaultEntries);
    const print = diffPrinterS({ context: 1 }, m1);

    // Initial seed print (single-line sexp due to documented drift from OCaml's
    // multi-line [Sexp.to_string_hum]):
    expect(capture.read()).toMatchInlineSnapshot(`
      "((1 100) (2 200) (3 300) (4 400) (5 500) (6 600) (7 700) (8 800) (9 900) (10 1000) (11 1100) (12 1200) (13 1300) (14 1400) (15 1500) (16 1600) (17 1700) (18 1800) (19 1900) (20 2000))
      "
    `);

    const e2 = defaultEntries.map((p): readonly [number, number] => (p[0] === 10 ? [10, 999] : p));
    print(intMapSexp(e2));
    expect(capture.read()).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|((1 100) (2 200) (3 300) (4 400) (5 500) (6 600) (7 700) (8 800) (9 900) (10 1000) (11 1100) (12 1200) (13 1300) (14 1400) (15 1500) (16 1600) (17 1700) (18 1800) (19 1900) (20 2000))
      +|((1 100) (2 200) (3 300) (4 400) (5 500) (6 600) (7 700) (8 800) (9 900) (10 999) (11 1100) (12 1200) (13 1300) (14 1400) (15 1500) (16 1600) (17 1700) (18 1800) (19 1900) (20 2000))
      "
    `);
  });

  it("passing null/undefined as [initial] delays the first print", () => {
    const print = diffPrinterS({ context: 1 }, undefined);
    expect(capture.read()).toBe("");

    const m1 = intMapSexp(defaultEntries);
    print(m1);
    expect(capture.read()).toMatchInlineSnapshot(`
      "((1 100) (2 200) (3 300) (4 400) (5 500) (6 600) (7 700) (8 800) (9 900) (10 1000) (11 1100) (12 1200) (13 1300) (14 1400) (15 1500) (16 1600) (17 1700) (18 1800) (19 1900) (20 2000))
      "
    `);
  });
});

// ---------- pure (no-stdout) helpers ----------

describe("patdiff (pure)", () => {
  it("returns an empty string for identical input", () => {
    expect(patdiff({}, "abc", "abc")).toBe("");
  });

  it("returns the diff for differing input", () => {
    expect(patdiff({}, "cat", "dog")).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|cat
      +|dog"
    `);
  });

  it("diffToString is an alias for patdiff", () => {
    expect(diffToString({}, "cat", "dog")).toBe(patdiff({}, "cat", "dog"));
  });
});

describe("patdiffS (pure)", () => {
  it("returns an empty string for identical sexps", () => {
    expect(patdiffS({}, sexp1, sexp1)).toBe("");
  });

  it("returns the diff for differing sexps", () => {
    expect(patdiffS({}, sexp1, sexp2)).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|(Node (left Leaf) (key one) (right (Node (left Leaf) (key two) (right (Node (left Leaf) (key three) (right Leaf))))))
      +|(Node (left (Node (left (Node (left Leaf) (key one) (right Leaf))) (key two) (right Leaf))) (key three) (right Leaf))"
    `);
  });
});

describe("locationStyle default", () => {
  it("defaults to Separator (=== DIFF HUNK ===)", () => {
    expect(patdiff({}, "cat", "dog")).toMatchInlineSnapshot(`
      "=== DIFF HUNK ===
      -|cat
      +|dog"
    `);
  });

  it("can be overridden", () => {
    expect(patdiff({ locationStyle: "Diff" }, "cat", "dog")).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|cat
      +|dog"
    `);
  });
});
