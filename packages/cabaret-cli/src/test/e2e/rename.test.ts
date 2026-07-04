import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("rename moves the branch, the log, and HEAD to the new name", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await addChange(repo, "feature");
  const tip = await repo.git("rev-parse", "feature");
  // An uncommitted edit rides across the rename: the move is ref-only.
  await repo.write("feature.txt", "feature work, unsaved\n");
  expect(await repo.cabaret("rename", "feature", "better-feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("rev-parse", "better-feature")).toBe(tip);
  expect(await repo.git("branch", "--list", "feature")).toBe("");
  expect(await repo.git("for-each-ref", "refs/cabaret/log", "--format=%(refname)")).toBe(
    "refs/cabaret/log/better-feature",
  );
  expect(await repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/better-feature");
  expect(await repo.git("status", "--porcelain")).toBe(" M feature.txt");
  expect(await repo.cabaret("log", "better-feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("renaming a change that is not checked out leaves HEAD alone", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "widget");
  expect(await repo.cabaret("rename", "widget", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await repo.git("branch", "--list", "gadget")).toBe("  gadget");
});

test("rename refuses a name already taken by a change or a branch", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gizmo");
  await repo.cabaret("create", "doodad");
  await repo.git("branch", "plain");
  const taken = await repo.cabaret("rename", "gizmo", "doodad");
  expect(taken.exitCode).toBe(1);
  expect(taken.stderr).toContain('change already exists: "doodad"');
  const shadowed = await repo.cabaret("rename", "gizmo", "plain");
  expect(shadowed.exitCode).toBe(1);
  expect(shadowed.stderr).toContain('branch already exists: "plain"');
  // The refused renames moved nothing: branch, log, and HEAD all stand.
  expect(await repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/gizmo");
  expect(await repo.git("branch", "--list", "gizmo")).toBe("* gizmo");
  expect((await repo.cabaret("log", "gizmo")).stdout).not.toBe("");
});

test("rename refuses a name that is not a change", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("rename", "nonesuch", "elsewhere");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change does not exist: "nonesuch"');
});

test("rename refuses a landed change", async () => {
  const repo = await makeRepo();
  await addChange(repo, "shipped");
  await repo.cabaret("land");
  const result = await repo.cabaret("rename", "shipped", "sailed");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change has landed: "shipped"');
});

test("only the owner may rename, unless overridden", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "theirs", "--owner", "bob@example.com");
  const refused = await repo.cabaret("rename", "theirs", "mine");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain('"theirs" is owned by "bob@example.com", not "alice@example.com"');
  expect(await repo.cabaret("rename", "theirs", "mine", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("owner", "show", "mine")).toEqual({
    stdout: "bob@example.com\n",
    stderr: "",
    exitCode: 0,
  });
});
