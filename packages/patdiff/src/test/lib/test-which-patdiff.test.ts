/** Port of OCaml's [patdiff/test/src/test_which_patdiff.ml].
 *
 *  The OCaml test verifies that the test-bench installs `patdiff` into the
 *  PATH via a Jenga link (so `which patdiff` resolves under $TMPDIR). The TS
 *  CLI is invoked via [tsx src/bin/main.ts] directly from this repo; there is
 *  no equivalent installed-binary check that's meaningful here. */

import { describe, it } from "vitest";

describe("which patdiff", () => {
  it.skip("which patdiff (N/A in TS test setup)", () => {});
});
