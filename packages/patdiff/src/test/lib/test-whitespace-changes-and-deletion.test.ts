/** Port of OCaml's [patdiff/test/src/test_whitespace_changes_and_deletion.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

describe("whitespace changes and deletion", () => {
  const prev = `
    assert (
      Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));
    assert (
      Int.( = )
        (Set.length t.by_varying_usage)
        (Hashtbl.length t.bucket_id_to_keys)))
`;
  const next = `
  assert (Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));
  assert (
    Int.( = ) (Set.length t.by_varying_usage) (Hashtbl.length t.bucket_id_to_keys))
`;

  it("default", () => {
    expect(patdiff({ prev, next })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,7 +1,4(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:green fg:black)+|(bg:default fg:green)  assert (Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));(fg:default)
      (bg:gray fg:black) |(bg:default fg:default)  assert (
      (bg:yellow fg:black)!|(bg:default fg:default)      Int.( = ) (Set.length t.by_varying_usage) ((fg:red)Set.length t.by_constant_usage));(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)    assert ((fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)      Int.( = )(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)        (Set.length t.by_varying_usage)(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)        ((fg:default)Hashtbl.length t.bucket_id_to_keys(fg:red))(fg:default)))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("-no-semantic-cleanup", () => {
    expect(patdiff({ prev, next, extraFlags: ["-no-semantic-cleanup"] })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,7 +1,4(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:green fg:black)+|(bg:default fg:green)  assert (Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));(fg:default)
      (bg:gray fg:black) |(bg:default fg:default)  assert (
      (bg:yellow fg:black)!|(bg:default fg:default)      Int.( = ) (Set.length t.by_varying_usage) ((fg:red)Set.length t.by_constant_usage));(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)    assert ((fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)      Int.( = )(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)        (Set.length t.by_varying_usage)(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red)        ((fg:default)Hashtbl.length t.bucket_id_to_keys(fg:red))(fg:default)))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("with extra newlines", () => {
    const prev2 = `
    assert (
      Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));

    assert (
      Int.( = )
        (Set.length t.by_varying_usage)
        (Hashtbl.length t.bucket_id_to_keys)))
`;
    const next2 = `
  assert (Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));

  assert (
    Int.( = ) (Set.length t.by_varying_usage) (Hashtbl.length t.bucket_id_to_keys))
`;
    expect(patdiff({ prev: prev2, next: next2 })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,8 +1,5(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:gray fg:black) |(bg:default fg:default)  assert (Int.( = ) (Set.length t.by_varying_usage) (Set.length t.by_constant_usage));
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:gray fg:black) |(bg:default fg:default)  assert (
      (bg:yellow fg:black)!|(bg:default fg:default)      Int.( = )
      (bg:yellow fg:black)!|(bg:default fg:default)        (Set.length t.by_varying_usage)
      (bg:yellow fg:black)!|(bg:default fg:default)        (Hashtbl.length t.bucket_id_to_keys(fg:red))(fg:default)))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});
