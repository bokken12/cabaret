/** Property tests for ANSI parsing, translated from OCaml's [test_parsing.ml].
 *
 *  Three properties:
 *
 *  1. Parsing is idempotent: [parse(toString(parse(s)))] equals [parse(s)].
 *  2. [toString] output always re-parses cleanly: no [Text] element in the re-parsed
 *     result contains an "\x1b[" or "\x1b]" substring (which would indicate that an
 *     escape sequence was emitted in a form the parser can't recognise).
 *  3. Parsing never puts an ESC (0x1b) into a [Text] element. */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as AnsiText from "./ansi-text.js";

const { parse, toString } = AnsiText;

// 500 runs over an input space of length-50 strings with high ESC density; still well
// under a second locally. OCaml's default trial count is 1000.
const NUM_RUNS = 500;

// String arbitrary that mixes plain characters with ANSI structural bytes. Weights are
// chosen to mirror OCaml's [weighted_union] used in [test_parsing.ml].
const ansiCharArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constant("\x1b"), weight: 1 },
  { arbitrary: fc.constant("["), weight: 1 },
  { arbitrary: fc.constant("]"), weight: 1 },
  { arbitrary: fc.constant("\\"), weight: 1 },
  { arbitrary: fc.constant("m"), weight: 1 },
  { arbitrary: fc.constant(";"), weight: 1 },
  // Colon-form SGR subparams and CSI intermediate bytes.
  { arbitrary: fc.constant(":"), weight: 1 },
  { arbitrary: fc.constant(" "), weight: 1 },
  {
    arbitrary: fc.integer({ min: 0x30, max: 0x39 }).map((n) => String.fromCharCode(n)),
    weight: 3,
  },
  {
    arbitrary: fc.integer({ min: 0, max: 51 }).map((n) => String.fromCharCode(n < 26 ? 97 + n : 65 + (n - 26))),
    weight: 2,
  },
  {
    arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((n) => String.fromCharCode(n)),
    weight: 1,
  },
);

const ansiStringArb: fc.Arbitrary<string> = fc
  .array(ansiCharArb, { minLength: 0, maxLength: 50 })
  .map((cs) => cs.join(""));

// Higher-ESC arbitrary used for the "ESC never leaks into text" property — stress-tests
// the parser by emitting roughly twice as many ESC bytes as separators/letters.
const escHeavyCharArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constant("\x1b"), weight: 2 },
  { arbitrary: fc.constant("["), weight: 1 },
  { arbitrary: fc.constant("]"), weight: 1 },
  { arbitrary: fc.constant("\\"), weight: 1 },
  { arbitrary: fc.constant("m"), weight: 1 },
  { arbitrary: fc.constant(";"), weight: 1 },
  { arbitrary: fc.constant(":"), weight: 1 },
  { arbitrary: fc.constant(" "), weight: 1 },
  {
    arbitrary: fc.integer({ min: 0x30, max: 0x39 }).map((n) => String.fromCharCode(n)),
    weight: 2,
  },
  {
    arbitrary: fc.integer({ min: 0, max: 51 }).map((n) => String.fromCharCode(n < 26 ? 97 + n : 65 + (n - 26))),
    weight: 2,
  },
);

const escHeavyStringArb: fc.Arbitrary<string> = fc
  .array(escHeavyCharArb, { minLength: 0, maxLength: 50 })
  .map((cs) => cs.join(""));

describe("parsing properties", () => {
  it("parsing is idempotent (parse . to_string . parse = parse)", () => {
    fc.assert(
      fc.property(ansiStringArb, (s) => {
        const once = parse(s);
        const twice = parse(toString(once));
        // [Ansi_text.t] doesn't have a deep equality; compare via [toString], which is a
        // canonical form (idempotent parses serialize the same way).
        expect(toString(twice)).toBe(toString(once));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("to_string output always parses cleanly (no malformed escapes in text)", () => {
    // The OCaml test uses [%quickcheck.generator: Ansi_text.t]. We don't have a
    // sexp-based generator here, so we approximate by parsing a random string to get an
    // arbitrary [Ansi_text.t]; this still exercises every code path that can produce a
    // [Text] element.
    fc.assert(
      fc.property(ansiStringArb, (s) => {
        const t = parse(s);
        const serialized = toString(t);
        const reparsed = parse(serialized);
        for (const el of reparsed) {
          if (el.kind === "Text") {
            const inner = el.text.str;
            expect(inner.includes("\x1b[")).toBe(false);
            expect(inner.includes("\x1b]")).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("parsing never puts ESC in a Text element", () => {
    fc.assert(
      fc.property(escHeavyStringArb, (s) => {
        const parsed = parse(s);
        for (const el of parsed) {
          if (el.kind === "Text") {
            expect(el.text.str.includes("\x1b")).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
