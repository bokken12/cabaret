import { forgeChangeId, parseBranchName, parseCommitHash, UserError, userName } from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ForgejoClient, parseForgejoRemote } from "../client.js";
import { ForgejoForge } from "../forge.js";
import { type Route, stubForgejo } from "./stub.js";

describe("parseForgejoRemote", () => {
  test("accepts the URL forms git uses for codeberg.org", () => {
    expect(parseForgejoRemote("https://codeberg.org/test-org/widgets.git")).toEqual({
      owner: "test-org",
      repo: "widgets",
    });
    expect(parseForgejoRemote("https://codeberg.org/alice/dotfiles")).toEqual({ owner: "alice", repo: "dotfiles" });
    expect(parseForgejoRemote("git@codeberg.org:test-org/widgets.git")).toEqual({
      owner: "test-org",
      repo: "widgets",
    });
    expect(parseForgejoRemote("ssh://git@codeberg.org/bob/tools.git")).toEqual({ owner: "bob", repo: "tools" });
  });

  test("lowercases, so every spelling of one repository yields one locator", () => {
    expect(parseForgejoRemote("https://Codeberg.org/Test-Org/Widgets.git")).toEqual({
      owner: "test-org",
      repo: "widgets",
    });
  });

  test("rejects URLs that are not codeberg.org repositories", () => {
    expect(() => parseForgejoRemote("https://github.com/test-org/widgets.git")).toThrow(UserError);
    expect(() => parseForgejoRemote("git@codeberg.org:widgets.git")).toThrow(UserError);
    expect(() => parseForgejoRemote("/home/alice/widgets")).toThrow(UserError);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://codeberg.org/api/v1";
const REPO = `${API}/repos/test-org/widgets`;
const SLIM_COMMIT = "stat=false&verification=false&files=false";

function forge(): ForgejoForge {
  return new ForgejoForge(new ForgejoClient("token-123", { throttled: false }), {
    owner: "test-org",
    repo: "widgets",
  });
}

/** A 40-hex commit hash derived from `n`, so bulk fixtures stay distinct. */
function shaOf(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** An open PR fixture for bulk tests; the mapping-critical tests spell theirs out inline. */
function openPr(number: number, head: string): Record<string, unknown> {
  return {
    number,
    title: `Change ${number}`,
    user: { login: "alice" },
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: { ref: head, sha: shaOf(number) },
    base: { ref: "main" },
    requested_reviewers: null,
  };
}

describe("ForgejoForge", () => {
  test("locator names the repository", () => {
    expect(forge().locator).toBe("codeberg.org/test-org/widgets");
  });

  test("requests carry the token", async () => {
    const calls = stubForgejo({
      [`PATCH ${REPO}/pulls/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.headers.authorization).toBe("token token-123");
  });

  test("currentSelf is the token's account, its email an alias", async () => {
    stubForgejo({
      [`GET ${API}/user`]: { json: { login: "alice", email: "alice@example.com" } },
    });
    expect(await forge().currentSelf()).toEqual({ user: "codeberg:alice", aliases: new Set(["alice@example.com"]) });
  });

  test("currentSelf of an account with no email has no aliases", async () => {
    stubForgejo({
      [`GET ${API}/user`]: { json: { login: "bob", email: "" } },
    });
    expect(await forge().currentSelf()).toEqual({ user: "codeberg:bob", aliases: new Set() });
  });

  test("getChange maps an open PR, unioning requested reviewers with submitted reviews", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls/7`]: {
        json: {
          number: 7,
          title: "Add tables",
          user: { login: "alice" },
          state: "open",
          draft: false,
          merged: false,
          merge_commit_sha: null,
          head: { ref: "add-tables", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
          base: { ref: "main" },
          requested_reviewers: [{ login: "carol" }, { login: "bob" }],
        },
      },
      [`GET ${REPO}/pulls/7/reviews?limit=50&page=1`]: {
        json: [
          { user: { login: "dave" }, state: "APPROVED" },
          // carol both requested and reviewed: one reviewer, not two.
          { user: { login: "carol" }, state: "COMMENT" },
          // A pending review is an unsubmitted draft, and a team review has
          // no user; neither makes a reviewer.
          { user: { login: "eve" }, state: "PENDING" },
          { user: null, state: "APPROVED" },
        ],
      },
    });
    expect(await forge().getChange(forgeChangeId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "codeberg:alice",
      state: "open",
      draft: false,
      reviewers: ["codeberg:bob", "codeberg:carol", "codeberg:dave"],
    });
  });

  test("getChange maps a true merge, reading its shape off the landed commit", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls/8`]: {
        json: {
          number: 8,
          title: "Fix crash",
          user: { login: "bob" },
          state: "closed",
          draft: false,
          merged: true,
          merge_commit_sha: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          head: { ref: "fix-crash", sha: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877" },
          base: { ref: "release" },
          requested_reviewers: [],
        },
      },
      [`GET ${REPO}/pulls/8/reviews?limit=50&page=1`]: { json: [] },
      [`GET ${REPO}/git/commits/89e6c98d92887913cadf06b2adb97f26cde4849b?${SLIM_COMMIT}`]: {
        json: {
          parents: [
            { sha: "1111111111111111111111111111111111111111" },
            { sha: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877" },
          ],
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(8))).toEqual({
      id: 8,
      head: "fix-crash",
      tip: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
      parent: "release",
      title: "Fix crash",
      author: "codeberg:bob",
      state: "merged",
      draft: false,
      reviewers: [],
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    });
  });

  test("a squash landing reports no reviewed ancestry", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls/9`]: {
        json: {
          number: 9,
          title: "Polish",
          user: { login: "carol" },
          state: "closed",
          draft: false,
          merged: true,
          merge_commit_sha: "2222222222222222222222222222222222222222",
          head: { ref: "polish", sha: "44556677889900aabbccddeeff112233445566aa" },
          base: { ref: "main" },
          requested_reviewers: null,
        },
      },
      [`GET ${REPO}/pulls/9/reviews?limit=50&page=1`]: { json: [] },
      [`GET ${REPO}/git/commits/2222222222222222222222222222222222222222?${SLIM_COMMIT}`]: {
        json: { parents: [{ sha: "1111111111111111111111111111111111111111" }] },
      },
    });
    expect((await forge().getChange(forgeChangeId(9))).merge).toEqual({
      commit: "2222222222222222222222222222222222222222",
      parents: 1,
    });
  });

  test("a rebase-then-merge landing reports no reviewed ancestry", async () => {
    // The merge commit's second parent is the rebased head, not the head
    // that was reviewed, so `parents` is 1 despite the two-parent commit.
    stubForgejo({
      [`GET ${REPO}/pulls/10`]: {
        json: {
          number: 10,
          title: "Tidy",
          user: { login: "carol" },
          state: "closed",
          draft: false,
          merged: true,
          merge_commit_sha: "2222222222222222222222222222222222222222",
          head: { ref: "tidy", sha: "5566778899aabbccddeeff001122334455667788" },
          base: { ref: "main" },
          requested_reviewers: null,
        },
      },
      [`GET ${REPO}/pulls/10/reviews?limit=50&page=1`]: { json: [] },
      [`GET ${REPO}/git/commits/2222222222222222222222222222222222222222?${SLIM_COMMIT}`]: {
        json: {
          parents: [
            { sha: "1111111111111111111111111111111111111111" },
            { sha: "3333333333333333333333333333333333333333" },
          ],
        },
      },
    });
    expect((await forge().getChange(forgeChangeId(10))).merge).toEqual({
      commit: "2222222222222222222222222222222222222222",
      parents: 1,
    });
  });

  test("a manually merged PR without a merge commit lands its head", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls/15`]: {
        json: {
          number: 15,
          title: "Hotfix",
          user: { login: "bob" },
          state: "closed",
          draft: false,
          merged: true,
          merge_commit_sha: null,
          head: { ref: "hotfix", sha: "8899aabbccddeeff001122334455667788990011" },
          base: { ref: "main" },
          requested_reviewers: [],
        },
      },
      [`GET ${REPO}/pulls/15/reviews?limit=50&page=1`]: { json: [] },
      [`GET ${REPO}/git/commits/8899aabbccddeeff001122334455667788990011?${SLIM_COMMIT}`]: {
        json: { parents: [{ sha: "1111111111111111111111111111111111111111" }] },
      },
    });
    expect((await forge().getChange(forgeChangeId(15))).merge).toEqual({
      commit: "8899aabbccddeeff001122334455667788990011",
      parents: 1,
    });
  });

  test("getChange maps a closed, authorless draft to the ghost identity", async () => {
    const calls = stubForgejo({
      [`GET ${REPO}/pulls/11`]: {
        json: {
          number: 11,
          title: "WIP: Abandoned",
          user: null,
          state: "closed",
          draft: true,
          merged: false,
          merge_commit_sha: null,
          head: { ref: "abandoned", sha: "44556677889900aabbccddeeff112233445566aa" },
          base: { ref: "main" },
          requested_reviewers: null,
        },
      },
      [`GET ${REPO}/pulls/11/reviews?limit=50&page=1`]: { json: [] },
    });
    expect(await forge().getChange(forgeChangeId(11))).toEqual({
      id: 11,
      head: "abandoned",
      tip: "44556677889900aabbccddeeff112233445566aa",
      parent: "main",
      title: "WIP: Abandoned",
      author: "codeberg:ghost",
      state: "closed",
      draft: true,
      reviewers: [],
    });
    expect(calls).toHaveLength(2);
  });

  test("a missing pull request surfaces as a UserError, not a parse failure", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls/99`]: { status: 404, json: { message: "The target couldn't be found." } },
    });
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(UserError);
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(
      "no pull request #99 on codeberg.org/test-org/widgets",
    );
  });

  test("findChange lists open PRs and collapses a shared branch to the lowest number", async () => {
    const calls = stubForgejo({
      [`GET ${REPO}/pulls?state=open&limit=50&page=1`]: {
        json: [openPr(9, "add-tables"), openPr(3, "other"), openPr(7, "add-tables")],
      },
      [`GET ${REPO}/pulls/7/reviews?limit=50&page=1`]: { json: [] },
    });
    expect(await forge().findChange(parseBranchName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: shaOf(7),
      parent: "main",
      title: "Change 7",
      author: "codeberg:alice",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls.map(({ url }) => url)).toEqual([
      `${REPO}/pulls?state=open&limit=50&page=1`,
      `${REPO}/pulls/7/reviews?limit=50&page=1`,
    ]);
  });

  test("findChange is undefined when no open PR has the branch", async () => {
    stubForgejo({
      [`GET ${REPO}/pulls?state=open&limit=50&page=1`]: { json: [openPr(3, "other")] },
    });
    expect(await forge().findChange(parseBranchName("orphan"))).toBeUndefined();
  });

  test("fetchChanges pages past a full page, carrying each PR's whole discussion", async () => {
    const routes: Record<string, Route> = {
      [`GET ${REPO}/pulls?state=open&limit=50&page=1`]: {
        json: Array.from({ length: 50 }, (_, i) => openPr(i + 1, `branch-${i + 1}`)),
      },
      [`GET ${REPO}/pulls?state=open&limit=50&page=2`]: { json: [openPr(51, "branch-51")] },
    };
    for (let n = 1; n <= 51; n++) {
      routes[`GET ${REPO}/issues/${n}/comments`] = { json: [] };
      routes[`GET ${REPO}/pulls/${n}/reviews?limit=50&page=1`] = { json: [] };
    }
    routes[`GET ${REPO}/issues/3/comments`] = {
      json: [{ id: 301, user: { login: "bob" }, body: "looks good", updated_at: "2026-05-01T00:00:00Z" }],
    };
    stubForgejo(routes);
    const { changes } = await forge().fetchChanges(undefined);
    expect(changes.map(({ change }) => change.id)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    expect(changes[2]).toEqual({
      change: {
        id: 3,
        head: "branch-3",
        tip: shaOf(3),
        parent: "main",
        title: "Change 3",
        author: "codeberg:alice",
        state: "open",
        draft: false,
        reviewers: [],
      },
      comments: [
        {
          id: "301",
          author: "codeberg:bob",
          body: "looks good",
          updatedAt: Date.parse("2026-05-01T00:00:00Z"),
        },
      ],
      commentsTruncated: false,
    });
  });

  test("createChange posts the PR and fetches it by number", async () => {
    const calls = stubForgejo({
      [`POST ${REPO}/pulls`]: { status: 201, json: { number: 12 } },
      [`GET ${REPO}/pulls/12`]: {
        json: {
          number: 12,
          title: "New work",
          user: { login: "dave" },
          state: "open",
          draft: false,
          merged: false,
          merge_commit_sha: null,
          head: { ref: "new-work", sha: "456789abcdef0123456789abcdef0123456789ab" },
          base: { ref: "parent-branch" },
          requested_reviewers: null,
        },
      },
      [`GET ${REPO}/pulls/12/reviews?limit=50&page=1`]: { json: [] },
    });
    expect(
      await forge().createChange(parseBranchName("new-work"), parseBranchName("parent-branch"), "New work", false),
    ).toEqual({
      id: 12,
      head: "new-work",
      tip: "456789abcdef0123456789abcdef0123456789ab",
      parent: "parent-branch",
      title: "New work",
      author: "codeberg:dave",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls[0]?.body).toBe(JSON.stringify({ head: "new-work", base: "parent-branch", title: "New work" }));
  });

  test("createChange opens a draft under the work-in-progress prefix", async () => {
    const calls = stubForgejo({
      [`POST ${REPO}/pulls`]: { status: 201, json: { number: 13 } },
      [`GET ${REPO}/pulls/13`]: {
        json: {
          number: 13,
          title: "WIP: Sketch",
          user: { login: "dave" },
          state: "open",
          draft: true,
          merged: false,
          merge_commit_sha: null,
          head: { ref: "sketch", sha: "56789abcdef0123456789abcdef0123456789abc" },
          base: { ref: "main" },
          requested_reviewers: null,
        },
      },
      [`GET ${REPO}/pulls/13/reviews?limit=50&page=1`]: { json: [] },
    });
    expect((await forge().createChange(parseBranchName("sketch"), parseBranchName("main"), "Sketch", true)).draft).toBe(
      true,
    );
    expect(calls[0]?.body).toBe(JSON.stringify({ head: "sketch", base: "main", title: "WIP: Sketch" }));
  });

  test("setParent patches the PR's base branch", async () => {
    const calls = stubForgejo({
      [`PATCH ${REPO}/pulls/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.body).toBe(JSON.stringify({ base: "develop" }));
  });

  test("setDraft marks a draft by prefixing the title", async () => {
    const calls = stubForgejo({
      [`GET ${REPO}/pulls/12`]: { json: { title: "Add tables", draft: false } },
      [`PATCH ${REPO}/pulls/12`]: { json: {} },
    });
    await forge().setDraft(forgeChangeId(12), true);
    expect(calls[1]?.body).toBe(JSON.stringify({ title: "WIP: Add tables" }));
  });

  test("setDraft marks ready by stripping whichever prefix the title carries", async () => {
    const calls = stubForgejo({
      [`GET ${REPO}/pulls/12`]: { json: { title: "[WIP] Add tables", draft: true } },
      [`PATCH ${REPO}/pulls/12`]: { json: {} },
    });
    await forge().setDraft(forgeChangeId(12), false);
    expect(calls[1]?.body).toBe(JSON.stringify({ title: "Add tables" }));
  });

  test("setDraft skips the write when the state already matches", async () => {
    const calls = stubForgejo({
      [`GET ${REPO}/pulls/12`]: { json: { title: "WIP: Add tables", draft: true } },
    });
    await forge().setDraft(forgeChangeId(12), true);
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${REPO}/pulls/12`]);
  });

  test("landChange merges at the validated tip and reads the shape off the landed commit", async () => {
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    const calls = stubForgejo({
      [`POST ${REPO}/pulls/7/merge`]: { json: null },
      [`GET ${REPO}/pulls/7`]: { json: { merge_commit_sha: "89e6c98d92887913cadf06b2adb97f26cde4849b" } },
      [`GET ${REPO}/git/commits/89e6c98d92887913cadf06b2adb97f26cde4849b?${SLIM_COMMIT}`]: {
        json: { parents: [{ sha: "1111111111111111111111111111111111111111" }, { sha: tip }] },
      },
    });
    expect(await forge().landChange(forgeChangeId(7), "merge", tip, "land: add-tables", "Cabaret-Landed: yes")).toEqual(
      { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    );
    expect(calls[0]?.body).toBe(
      JSON.stringify({
        Do: "merge",
        MergeTitleField: "land: add-tables",
        MergeMessageField: "Cabaret-Landed: yes",
        head_commit_id: tip,
      }),
    );
  });

  test("a squash land returns the single squash commit", async () => {
    const tip = parseCommitHash("0f9e8d7c6b5a49382716053f4e3d2c1b0a998877");
    const calls = stubForgejo({
      [`POST ${REPO}/pulls/8/merge`]: { json: null },
      [`GET ${REPO}/pulls/8`]: { json: { merge_commit_sha: "3333333333333333333333333333333333333333" } },
      [`GET ${REPO}/git/commits/3333333333333333333333333333333333333333?${SLIM_COMMIT}`]: {
        json: { parents: [{ sha: "1111111111111111111111111111111111111111" }] },
      },
    });
    expect(await forge().landChange(forgeChangeId(8), "squash", tip, "land: fix-crash", "body")).toEqual({
      commit: "3333333333333333333333333333333333333333",
      parents: 1,
    });
    expect((JSON.parse(calls[0]?.body ?? "{}") as { Do: string }).Do).toBe("squash");
  });

  test("a moved head surfaces as a UserError naming the PR", async () => {
    stubForgejo({
      [`POST ${REPO}/pulls/7/merge`]: { status: 409, json: { message: "head commit ID does not match" } },
    });
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    await expect(forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).rejects.toThrow(UserError);
    await expect(forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).rejects.toThrow(
      /codeberg\.org\/test-org\/widgets#7 did not merge: .*head commit ID does not match/,
    );
  });

  test("listComments maps the whole discussion, oldest first", async () => {
    stubForgejo({
      [`GET ${REPO}/issues/7/comments`]: {
        json: [
          { id: 101, user: { login: "alice" }, body: "first", updated_at: "2026-05-01T00:00:00Z" },
          { id: 103, user: { login: "bob" }, body: "second", updated_at: "2026-05-02T12:30:00Z" },
          { id: 104, user: null, body: "orphaned", updated_at: "2026-05-03T08:00:00Z" },
        ],
      },
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      { id: "101", author: "codeberg:alice", body: "first", updatedAt: Date.parse("2026-05-01T00:00:00Z") },
      {
        id: "103",
        author: "codeberg:bob",
        body: "second",
        updatedAt: Date.parse("2026-05-02T12:30:00Z"),
      },
      {
        id: "104",
        author: "codeberg:ghost",
        body: "orphaned",
        updatedAt: Date.parse("2026-05-03T08:00:00Z"),
      },
    ]);
  });

  test("addComment posts the body verbatim, marker included", async () => {
    const body = `ship it\n\n<!-- cabaret:${"ab".repeat(32)} -->`;
    const calls = stubForgejo({
      [`POST ${REPO}/issues/7/comments`]: { status: 201, json: {} },
    });
    await forge().addComment(forgeChangeId(7), body);
    expect(calls[0]?.body).toBe(JSON.stringify({ body }));
  });

  test("setReviewers resolves every identity form, requesting adds and withdrawing removes", async () => {
    const calls = stubForgejo({
      [`POST ${REPO}/pulls/21/requested_reviewers`]: { status: 201, json: {} },
      [`DELETE ${REPO}/pulls/21/requested_reviewers`]: { status: 204, json: null },
    });
    await forge().setReviewers(
      forgeChangeId(21),
      [userName("bob@noreply.codeberg.org"), userName("codeberg:alice")],
      [userName("eve@noreply.codeberg.org")],
    );
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${REPO}/pulls/21/requested_reviewers`,
      `DELETE ${REPO}/pulls/21/requested_reviewers`,
    ]);
    expect(calls[0]?.body).toBe(JSON.stringify({ reviewers: ["bob", "alice"] }));
    expect(calls[1]?.body).toBe(JSON.stringify({ reviewers: ["eve"] }));
  });

  test("an identity that names no codeberg.org account fails setReviewers as a UserError", async () => {
    stubForgejo({});
    const pending = forge().setReviewers(forgeChangeId(24), [userName("nobody@example.com")], []);
    await expect(pending).rejects.toThrow(UserError);
    await expect(pending).rejects.toThrow('"nobody@example.com" names no codeberg.org account; use codeberg:<login>');
  });

  test("a refused reviewer surfaces as a UserError naming the PR", async () => {
    stubForgejo({
      [`POST ${REPO}/pulls/25/requested_reviewers`]: {
        status: 422,
        json: { message: "poster of pr can't be reviewer" },
      },
    });
    await expect(forge().setReviewers(forgeChangeId(25), [userName("bob@noreply.codeberg.org")], [])).rejects.toThrow(
      /codeberg\.org\/test-org\/widgets#25 reviewers not updated: .*poster of pr/,
    );
  });

  test("a failing request reports the status and Forgejo's message", async () => {
    stubForgejo({
      [`GET ${REPO}/issues/404/comments`]: {
        status: 404,
        json: { message: "The target couldn't be found." },
      },
    });
    await expect(forge().listComments(forgeChangeId(404))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("The target couldn't be found.") as string,
    });
  });
});
