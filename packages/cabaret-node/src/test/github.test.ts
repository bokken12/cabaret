import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ForgeRequestId, forgeRequestId, parseRefName } from "cabaret-core";
import { describe, expect, onTestFinished, test } from "vitest";
import { GitHubForge } from "../github.js";

// Live tests against a real GitHub repository, covering what FakeForge
// cannot: the exact `gh` invocations and GitHub's actual responses. Skipped
// unless a fixture repository (created once by scripts/seed-forge-fixture.sh)
// is named:
//
//   CABARET_FORGE_FIXTURE=<owner>/<repo> pnpm vitest run packages/cabaret-node
//
// The read suite only inspects the fixture's seeded state. The write suite
// opens, comments on, retargets, and closes a PR per run, so it additionally
// requires CABARET_FORGE_WRITES=1.
const FIXTURE = process.env.CABARET_FORGE_FIXTURE;
const WRITES = process.env.CABARET_FORGE_WRITES === "1";

const execFileAsync = promisify(execFile);

const SEEDED = forgeRequestId(1);

/** Clone the fixture repository into a throwaway directory and open it. */
async function openFixture(fixture: string): Promise<{ dir: string; forge: GitHubForge }> {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-forge-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await execFileAsync("gh", ["repo", "clone", fixture, dir, "--", "--quiet"]);
  return { dir, forge: await GitHubForge.open(dir) };
}

describe.skipIf(FIXTURE === undefined)("GitHubForge reads the live fixture", () => {
  test("open derives the locator from the origin remote", async () => {
    const { forge } = await openFixture(FIXTURE ?? "");
    expect(forge.locator).toBe(`github.com/${FIXTURE}`);
  }, 60000);

  test("getRequest reads the seeded merged PR, including its merge commit", async () => {
    const { forge } = await openFixture(FIXTURE ?? "");
    expect(await forge.getRequest(SEEDED)).toEqual({
      id: SEEDED,
      head: "seeded",
      base: "main",
      title: "seeded",
      state: "merged",
      merge: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
  }, 60000);

  test("listComments paginates through all 105 seeded comments, oldest first", async () => {
    const { forge } = await openFixture(FIXTURE ?? "");
    const comments = await forge.listComments(SEEDED);
    expect(comments.map(({ body }) => body)).toEqual(
      Array.from({ length: 105 }, (_, index) => `seed comment ${index + 1}`),
    );
    for (const comment of comments) {
      expect(comment.author).toMatch(/@users\.noreply\.github\.com$/);
      expect(comment.updatedAt).toBeGreaterThan(0);
    }
  }, 60000);

  test("findRequest is undefined for a branch with no open PR", async () => {
    const { forge } = await openFixture(FIXTURE ?? "");
    expect(await forge.findRequest(parseRefName("main"))).toBeUndefined();
  }, 60000);
});

describe.skipIf(FIXTURE === undefined || !WRITES)("GitHubForge writes to the live fixture", () => {
  test("create, find, comment on, and retarget a PR", async () => {
    const { dir, forge } = await openFixture(FIXTURE ?? "");
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await git("config", "user.name", "Cabaret Fixture");
    await git("config", "user.email", "fixture@example.com");
    // Live state makes true determinism impossible; a timestamped branch at
    // least keeps concurrent runs off each other's toes.
    const branch = parseRefName(`test-${Date.now()}`);
    await git("checkout", "-qb", branch);
    await writeFile(join(dir, `${branch}.txt`), `${branch}\n`);
    await git("add", "-A");
    await git("commit", "-qm", `${branch} work`);
    await git("push", "-q", "origin", branch);
    let id: ForgeRequestId | undefined;
    onTestFinished(async () => {
      if (id !== undefined) {
        await execFileAsync("gh", ["pr", "close", String(id), "--delete-branch"], { cwd: dir });
      }
    });
    const created = await forge.createRequest(branch, parseRefName("main"), `live test ${branch}`);
    id = created.id;
    expect(created).toEqual({
      id: expect.any(Number),
      head: branch,
      base: "main",
      title: `live test ${branch}`,
      state: "open",
    });
    expect(await forge.findRequest(branch)).toEqual(created);
    // The exact body must survive the round trip: idempotency rides on the
    // raw marker coming back byte-identical.
    const body = `ship it\n\n<!-- cabaret:${"ab".repeat(32)} -->`;
    await forge.addComment(created.id, body);
    expect((await forge.listComments(created.id)).map((comment) => comment.body)).toEqual([body]);
    await forge.setBase(created.id, parseRefName("base2"));
    expect((await forge.getRequest(created.id)).base).toBe("base2");
  }, 300000);
});
