/** Port of OCaml's [patdiff/test/src/test_patdiff_git_wrapper.ml].
 *
 *  The OCaml test sets up a git repo, runs `git diff` with
 *  GIT_EXTERNAL_DIFF=patdiff-git-wrapper, and checks the rendered output.
 *
 *  Skipping in TS because the test is heavily platform-coupled (requires
 *  [git], [file], [sed], and a working PATH containing the just-built
 *  [patdiff] alongside the wrapper script). The TS wrapper at
 *  [src/bin/patdiff-git-wrapper] is a near-verbatim translation of the OCaml
 *  one, but exercising it from a unit test would require an in-process git
 *  setup that adds little value beyond verifying the wrapper script itself. */

import { describe, it } from "vitest";

describe("patdiff-git-wrapper", () => {
  it.skip("patdiff-git-wrapper (requires git + file + sed; skipped)", () => {});
});
