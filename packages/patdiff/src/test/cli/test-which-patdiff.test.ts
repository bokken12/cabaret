/** Port of OCaml's [patdiff/test/src/test-which-patdiff.t].
 *
 *  Skipped: the OCaml cram test verifies that bash's [type patdiff] points at
 *  the local-tree binary via a Jenga-installed shell function. There is no
 *  analogous concept in the TS test setup (we run [tsx src/bin/main.ts]
 *  directly), so this test is N/A. */

import { describe, it } from "vitest";

describe("which patdiff", () => {
  it.skip("which patdiff (N/A in TS test setup)", () => {});
});
