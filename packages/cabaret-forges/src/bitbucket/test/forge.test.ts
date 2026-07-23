import { forgeChangeId, forgeCursor, parseBranchName, parseCommitHash, UserError, userName } from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BitbucketClient, parseBitbucketRemote } from "../client.js";
import { BitbucketForge } from "../forge.js";
import { stubBitbucket } from "./stub.js";

// Node provides `btoa`; it is absent from the bare es2025 lib this
// platform-agnostic package compiles against.
declare const btoa: (raw: string) => string;

describe("parseBitbucketRemote", () => {
  test("accepts the URL forms git uses for bitbucket.org", () => {
    expect(parseBitbucketRemote("https://bitbucket.org/test-org/widgets.git")).toEqual({
      workspace: "test-org",
      slug: "widgets",
    });
    // Bitbucket's default HTTPS clone URL carries the account as userinfo.
    expect(parseBitbucketRemote("https://alice@bitbucket.org/alice/dotfiles")).toEqual({
      workspace: "alice",
      slug: "dotfiles",
    });
    expect(parseBitbucketRemote("git@bitbucket.org:test-org/widgets.git")).toEqual({
      workspace: "test-org",
      slug: "widgets",
    });
    expect(parseBitbucketRemote("ssh://git@bitbucket.org/bob/tools.git")).toEqual({
      workspace: "bob",
      slug: "tools",
    });
  });

  test("lowercases, so every spelling of one repository yields one locator", () => {
    expect(parseBitbucketRemote("https://Bitbucket.org/Test-Org/Widgets.git")).toEqual({
      workspace: "test-org",
      slug: "widgets",
    });
  });

  test("rejects URLs that are not bitbucket.org repositories", () => {
    expect(() => parseBitbucketRemote("https://github.com/test-org/widgets.git")).toThrow(UserError);
    expect(() => parseBitbucketRemote("git@bitbucket.org:widgets.git")).toThrow(UserError);
    expect(() => parseBitbucketRemote("/home/alice/widgets")).toThrow(UserError);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://api.bitbucket.org/2.0";
const REPO = `${API}/repositories/test-org/widgets`;
const LIST_TAIL = "fields=%2Bvalues.reviewers&pagelen=50";

function forge(): BitbucketForge {
  return new BitbucketForge(
    new BitbucketClient({ token: "token-123", email: "alice@example.com" }, { throttled: false }),
    { workspace: "test-org", slug: "widgets" },
    { pollMs: 0 },
  );
}

/** A 40-hex commit hash derived from `n`, so bulk fixtures stay distinct. */
function shaOf(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** One page of a paginated listing, linking to `next` when there is one. */
function page(values: readonly unknown[], next?: string): Record<string, unknown> {
  return { values, ...(next === undefined ? {} : { next }) };
}

/** An open PR fixture for bulk tests; the mapping-critical tests spell theirs out inline. */
function openPr(id: number, head: string): Record<string, unknown> {
  return {
    id,
    title: `Change ${id}`,
    author: { nickname: "alice" },
    state: "OPEN",
    draft: false,
    updated_on: "2026-05-02T10:00:00Z",
    comment_count: 0,
    source: { branch: { name: head }, commit: { hash: shaOf(id) } },
    destination: { branch: { name: "main" } },
    merge_commit: null,
    reviewers: [],
  };
}

describe("BitbucketForge", () => {
  test("locator names the repository", () => {
    expect(forge().locator).toBe("bitbucket.org/test-org/widgets");
  });

  test("requests carry basic credentials when an email accompanies the token", async () => {
    const calls = stubBitbucket({
      [`PUT ${REPO}/pullrequests/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa("alice@example.com:token-123")}`);
  });

  test("requests carry a bare token as a bearer", async () => {
    const calls = stubBitbucket({
      [`PUT ${REPO}/pullrequests/12`]: { json: {} },
    });
    const bearer = new BitbucketForge(new BitbucketClient({ token: "token-123" }, { throttled: false }), {
      workspace: "test-org",
      slug: "widgets",
    });
    await bearer.setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.headers.authorization).toBe("Bearer token-123");
  });

  test("currentSelf is the token's account, its confirmed emails aliases", async () => {
    stubBitbucket({
      [`GET ${API}/user`]: { json: { nickname: "alice" } },
      [`GET ${API}/user/emails?pagelen=50`]: {
        json: page([
          { email: "alice@example.com", is_confirmed: true },
          { email: "pending@example.com", is_confirmed: false },
        ]),
      },
    });
    expect(await forge().currentSelf()).toEqual({
      user: "bitbucket:alice",
      aliases: new Set(["alice@example.com"]),
    });
  });

  test("getChange maps an open PR, resolving the truncated tip through the commit", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: {
        json: {
          id: 7,
          title: "Add tables",
          author: { nickname: "alice" },
          state: "OPEN",
          draft: false,
          updated_on: "2026-05-02T10:00:00Z",
          comment_count: 3,
          source: { branch: { name: "add-tables" }, commit: { hash: "a1b2c3d4e5f6" } },
          destination: { branch: { name: "main" } },
          merge_commit: null,
          reviewers: [{ nickname: "carol" }, { nickname: "bob" }],
        },
      },
      [`GET ${REPO}/commit/a1b2c3d4e5f6?fields=hash`]: {
        json: { hash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
      },
    });
    expect(await forge().getChange(forgeChangeId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "bitbucket:alice",
      state: "open",
      draft: false,
      reviewers: ["bitbucket:bob", "bitbucket:carol"],
    });
  });

  test("a full tip hash is taken as is, with no resolution round trip", async () => {
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: { json: openPr(7, "add-tables") },
    });
    expect((await forge().getChange(forgeChangeId(7))).tip).toBe(shaOf(7));
    expect(calls).toHaveLength(1);
  });

  test("getChange maps a true merge, reading its shape off the landed commit", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/8`]: {
        json: {
          id: 8,
          title: "Fix crash",
          author: { nickname: "bob" },
          state: "MERGED",
          draft: false,
          updated_on: "2026-05-02T10:00:00Z",
          comment_count: 0,
          source: { branch: { name: "fix-crash" }, commit: { hash: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877" } },
          destination: { branch: { name: "release" } },
          merge_commit: { hash: "89e6c98d9288" },
          reviewers: [],
        },
      },
      [`GET ${REPO}/commit/89e6c98d9288?fields=hash%2Cparents.hash`]: {
        json: {
          hash: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          parents: [
            { hash: "1111111111111111111111111111111111111111" },
            { hash: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877" },
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
      author: "bitbucket:bob",
      state: "merged",
      draft: false,
      reviewers: [],
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    });
  });

  test("a squash landing reports no reviewed ancestry", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/9`]: {
        json: {
          ...openPr(9, "polish"),
          state: "MERGED",
          merge_commit: { hash: "222222222222" },
        },
      },
      [`GET ${REPO}/commit/222222222222?fields=hash%2Cparents.hash`]: {
        json: {
          hash: "2222222222222222222222222222222222222222",
          parents: [{ hash: "1111111111111111111111111111111111111111" }],
        },
      },
    });
    expect((await forge().getChange(forgeChangeId(9))).merge).toEqual({
      commit: "2222222222222222222222222222222222222222",
      parents: 1,
    });
  });

  test("a merge without a recorded merge commit lands its head", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/15`]: { json: { ...openPr(15, "hotfix"), state: "MERGED" } },
      [`GET ${REPO}/commit/${shaOf(15)}?fields=hash%2Cparents.hash`]: {
        json: { hash: shaOf(15), parents: [{ hash: "1111111111111111111111111111111111111111" }] },
      },
    });
    expect((await forge().getChange(forgeChangeId(15))).merge).toEqual({ commit: shaOf(15), parents: 1 });
  });

  test("getChange maps a declined, authorless draft to closed and the ghost identity", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/11`]: {
        json: { ...openPr(11, "abandoned"), author: null, state: "DECLINED", draft: true },
      },
    });
    expect(await forge().getChange(forgeChangeId(11))).toEqual({
      id: 11,
      head: "abandoned",
      tip: shaOf(11),
      parent: "main",
      title: "Change 11",
      author: "bitbucket:ghost",
      state: "closed",
      draft: true,
      reviewers: [],
    });
  });

  test("a missing pull request surfaces as a UserError, not a parse failure", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/99`]: { status: 404, json: { error: { message: "Resource not found" } } },
    });
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(UserError);
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(
      "no pull request #99 on bitbucket.org/test-org/widgets",
    );
  });

  test("findChange filters by branch on the server and collapses a shared branch to the lowest id", async () => {
    const query = encodeURIComponent('source.branch.name = "add-tables"');
    stubBitbucket({
      [`GET ${REPO}/pullrequests?state=OPEN&q=${query}&${LIST_TAIL}`]: {
        json: page([openPr(9, "add-tables"), openPr(7, "add-tables")]),
      },
    });
    expect(await forge().findChange(parseBranchName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: shaOf(7),
      parent: "main",
      title: "Change 7",
      author: "bitbucket:alice",
      state: "open",
      draft: false,
      reviewers: [],
    });
  });

  test("findChange is undefined when no open PR has the branch", async () => {
    const query = encodeURIComponent('source.branch.name = "orphan"');
    stubBitbucket({
      [`GET ${REPO}/pullrequests?state=OPEN&q=${query}&${LIST_TAIL}`]: { json: page([]) },
    });
    expect(await forge().findChange(parseBranchName("orphan"))).toBeUndefined();
  });

  test("fetchChanges follows next links, fetching only the discussions that exist", async () => {
    const second = `${REPO}/pullrequests?state=OPEN&${LIST_TAIL}&page=2`;
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests?state=OPEN&${LIST_TAIL}`]: {
        json: page([openPr(1, "branch-1"), { ...openPr(3, "branch-3"), comment_count: 1 }], second),
      },
      [`GET ${second}`]: { json: page([openPr(4, "branch-4")]) },
      [`GET ${REPO}/pullrequests/3/comments?pagelen=50`]: {
        json: page([
          {
            id: 301,
            user: { nickname: "bob" },
            content: { raw: "looks good" },
            updated_on: "2026-05-01T00:00:00Z",
            deleted: false,
            pending: false,
          },
        ]),
      },
    });
    const { changes, coverage, cursor } = await forge().fetchChanges(undefined);
    expect(coverage).toBe("open");
    expect(cursor).toBe(String(Date.parse("2026-05-02T09:55:00Z")));
    expect(changes.map(({ change }) => change.id)).toEqual([1, 3, 4]);
    expect(changes[1]).toEqual({
      change: {
        id: 3,
        head: "branch-3",
        tip: shaOf(3),
        parent: "main",
        title: "Change 3",
        author: "bitbucket:alice",
        state: "open",
        draft: false,
        reviewers: [],
      },
      comments: [
        { id: "301", author: "bitbucket:bob", body: "looks good", updatedAt: Date.parse("2026-05-01T00:00:00Z") },
      ],
      commentsTruncated: false,
    });
    // The PRs without comments cost no comments call.
    expect(calls.filter(({ url }) => url.includes("/comments"))).toHaveLength(1);
  });

  test("fetchChanges with a cursor asks for what moved after it, keeping every state", async () => {
    const query = encodeURIComponent('updated_on > "2026-06-01T00:00:00.000Z"');
    const states = "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED";
    stubBitbucket({
      [`GET ${REPO}/pullrequests?${states}&q=${query}&${LIST_TAIL}`]: {
        json: page([
          { ...openPr(7, "branch-7"), state: "DECLINED", updated_on: "2026-06-10T12:00:00Z" },
          { ...openPr(4, "branch-4"), updated_on: "2026-06-10T09:00:00Z" },
        ]),
      },
    });
    const sweep = await forge().fetchChanges(forgeCursor(String(Date.parse("2026-06-01T00:00:00Z"))));
    expect(sweep.coverage).toBe("since");
    expect(sweep.cursor).toBe(String(Date.parse("2026-06-10T11:55:00Z")));
    expect(sweep.changes.map(({ change }) => [change.id, change.state])).toEqual([
      [7, "closed"],
      [4, "open"],
    ]);
  });

  test("createChange posts the PR and fetches it by id", async () => {
    const calls = stubBitbucket({
      [`POST ${REPO}/pullrequests`]: { status: 201, json: { id: 12 } },
      [`GET ${REPO}/pullrequests/12`]: {
        json: { ...openPr(12, "new-work"), title: "New work", author: { nickname: "dave" } },
      },
    });
    expect(
      await forge().createChange(parseBranchName("new-work"), parseBranchName("parent-branch"), "New work"),
    ).toEqual({
      id: 12,
      head: "new-work",
      tip: shaOf(12),
      parent: "main",
      title: "New work",
      author: "bitbucket:dave",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({
        title: "New work",
        source: { branch: { name: "new-work" } },
        destination: { branch: { name: "parent-branch" } },
      }),
    );
  });

  test("setParent updates the PR's destination branch", async () => {
    const calls = stubBitbucket({
      [`PUT ${REPO}/pullrequests/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.body).toBe(JSON.stringify({ destination: { branch: { name: "develop" } } }));
  });

  test("setDraft updates the PR's draft flag", async () => {
    const calls = stubBitbucket({
      [`PUT ${REPO}/pullrequests/12`]: { json: {} },
    });
    await forge().setDraft(forgeChangeId(12), true);
    expect(calls[0]?.body).toBe(JSON.stringify({ draft: true }));
  });

  test("setState closes by declining", async () => {
    const calls = stubBitbucket({
      [`POST ${REPO}/pullrequests/12/decline`]: { json: {} },
    });
    await forge().setState(forgeChangeId(12), "closed");
    expect(calls).toHaveLength(1);
  });

  test("setState cannot reopen: declining is final on Bitbucket", async () => {
    stubBitbucket({});
    await expect(forge().setState(forgeChangeId(12), "open")).rejects.toThrow(
      "bitbucket.org/test-org/widgets#12 is declined, which bitbucket.org cannot reopen",
    );
  });

  test("landChange re-checks the tip, merges, and reads the shape off the landed commit", async () => {
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    const pr = {
      ...openPr(7, "add-tables"),
      source: { branch: { name: "add-tables" }, commit: { hash: "a1b2c3d4e5f6" } },
    };
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: { json: pr },
      [`POST ${REPO}/pullrequests/7/merge`]: {
        json: { ...pr, state: "MERGED", merge_commit: { hash: "89e6c98d9288" } },
      },
      [`GET ${REPO}/commit/89e6c98d9288?fields=hash%2Cparents.hash`]: {
        json: {
          hash: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          parents: [{ hash: "1111111111111111111111111111111111111111" }, { hash: tip }],
        },
      },
    });
    expect(await forge().landChange(forgeChangeId(7), "merge", tip, "land: add-tables", "Cabaret-Landed: yes")).toEqual(
      { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    );
    expect(calls[1]?.body).toBe(
      JSON.stringify({ message: "land: add-tables\n\nCabaret-Landed: yes", merge_strategy: "merge_commit" }),
    );
  });

  test("a squash land asks for the squash strategy", async () => {
    const pr = { ...openPr(8, "fix-crash"), comment_count: 0 };
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/8`]: { json: pr },
      [`POST ${REPO}/pullrequests/8/merge`]: {
        json: { ...pr, state: "MERGED", merge_commit: { hash: "333333333333" } },
      },
      [`GET ${REPO}/commit/333333333333?fields=hash%2Cparents.hash`]: {
        json: {
          hash: "3333333333333333333333333333333333333333",
          parents: [{ hash: "1111111111111111111111111111111111111111" }],
        },
      },
    });
    expect(await forge().landChange(forgeChangeId(8), "squash", parseCommitHash(shaOf(8)), "t", "m")).toEqual({
      commit: "3333333333333333333333333333333333333333",
      parents: 1,
    });
    expect((JSON.parse(calls[1]?.body ?? "{}") as { merge_strategy: string }).merge_strategy).toBe("squash");
  });

  test("an accepted merge that completes asynchronously is polled until it lands", async () => {
    const pr = openPr(7, "add-tables");
    stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: [
        { json: pr },
        { json: pr },
        { json: { ...pr, state: "MERGED", merge_commit: { hash: "89e6c98d9288" } } },
      ],
      [`POST ${REPO}/pullrequests/7/merge`]: { status: 202, json: { task_status: "PENDING" } },
      [`GET ${REPO}/commit/89e6c98d9288?fields=hash%2Cparents.hash`]: {
        json: {
          hash: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          parents: [{ hash: "1111111111111111111111111111111111111111" }, { hash: shaOf(7) }],
        },
      },
    });
    expect(await forge().landChange(forgeChangeId(7), "merge", parseCommitHash(shaOf(7)), "t", "m")).toEqual({
      commit: "89e6c98d92887913cadf06b2adb97f26cde4849b",
      parents: 2,
    });
  });

  test("a moved head surfaces as a UserError before anything merges", async () => {
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: { json: openPr(7, "add-tables") },
    });
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    await expect(forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).rejects.toThrow(
      "bitbucket.org/test-org/widgets#7 is not at the validated tip; run `cab sync` first",
    );
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  test("a refused merge surfaces as a UserError naming the PR", async () => {
    const pr = openPr(7, "add-tables");
    stubBitbucket({
      [`GET ${REPO}/pullrequests/7`]: { json: pr },
      [`POST ${REPO}/pullrequests/7/merge`]: {
        status: 400,
        json: { error: { message: "This pull request has conflicts" } },
      },
    });
    await expect(forge().landChange(forgeChangeId(7), "merge", parseCommitHash(shaOf(7)), "t", "m")).rejects.toThrow(
      /bitbucket\.org\/test-org\/widgets#7 did not merge: .*conflicts/,
    );
  });

  test("listComments keeps the change-level discussion, oldest first", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/7/comments?pagelen=50`]: {
        json: page([
          {
            id: 103,
            user: { nickname: "bob" },
            content: { raw: "second" },
            updated_on: "2026-05-02T12:30:00Z",
            deleted: false,
          },
          {
            id: 101,
            user: { nickname: "alice" },
            content: { raw: "first" },
            updated_on: "2026-05-01T00:00:00Z",
            deleted: false,
          },
          {
            id: 102,
            user: { nickname: "carol" },
            content: { raw: "inline nit" },
            updated_on: "2026-05-01T01:00:00Z",
            deleted: false,
            inline: { path: "src/tables.ts" },
          },
          {
            id: 104,
            user: { nickname: "carol" },
            content: { raw: "" },
            updated_on: "2026-05-01T02:00:00Z",
            deleted: true,
          },
          {
            id: 105,
            user: { nickname: "carol" },
            content: { raw: "unpublished draft" },
            updated_on: "2026-05-01T03:00:00Z",
            deleted: false,
            pending: true,
          },
          {
            id: 106,
            user: null,
            content: { raw: "orphaned" },
            updated_on: "2026-05-03T08:00:00Z",
            deleted: false,
          },
        ]),
      },
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      { id: "101", author: "bitbucket:alice", body: "first", updatedAt: Date.parse("2026-05-01T00:00:00Z") },
      { id: "103", author: "bitbucket:bob", body: "second", updatedAt: Date.parse("2026-05-02T12:30:00Z") },
      { id: "106", author: "bitbucket:ghost", body: "orphaned", updatedAt: Date.parse("2026-05-03T08:00:00Z") },
    ]);
  });

  test("addComment posts the body verbatim, marker included", async () => {
    const body = `ship it\n\n<!-- cabaret:${"ab".repeat(32)} -->`;
    const calls = stubBitbucket({
      [`POST ${REPO}/pullrequests/7/comments`]: { status: 201, json: {} },
    });
    await forge().addComment(forgeChangeId(7), body);
    expect(calls[0]?.body).toBe(JSON.stringify({ content: { raw: body } }));
  });

  test("setReviewers edits the reviewer list, resolving additions through the workspace", async () => {
    const memberQuery = encodeURIComponent('user.nickname = "carol"');
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/21?fields=reviewers.uuid%2Creviewers.nickname`]: {
        json: {
          reviewers: [
            { uuid: "{u-bob}", nickname: "bob" },
            { uuid: "{u-eve}", nickname: "eve" },
          ],
        },
      },
      [`GET ${API}/workspaces/test-org/members?q=${memberQuery}&pagelen=50`]: {
        json: page([{ user: { uuid: "{u-carol}" } }]),
      },
      [`PUT ${REPO}/pullrequests/21`]: { json: {} },
    });
    await forge().setReviewers(forgeChangeId(21), [userName("bitbucket:carol")], [userName("bitbucket:eve")]);
    expect(calls[2]?.body).toBe(JSON.stringify({ reviewers: [{ uuid: "{u-bob}" }, { uuid: "{u-carol}" }] }));
  });

  test("setReviewers skips the write when the list already matches", async () => {
    const calls = stubBitbucket({
      [`GET ${REPO}/pullrequests/21?fields=reviewers.uuid%2Creviewers.nickname`]: {
        json: { reviewers: [{ uuid: "{u-bob}", nickname: "bob" }] },
      },
    });
    await forge().setReviewers(forgeChangeId(21), [], [userName("bitbucket:dave")]);
    expect(calls).toHaveLength(1);
  });

  test("an identity that names no bitbucket.org account fails setReviewers as a UserError", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/24?fields=reviewers.uuid%2Creviewers.nickname`]: { json: { reviewers: [] } },
    });
    const pending = forge().setReviewers(forgeChangeId(24), [userName("nobody@example.com")], []);
    await expect(pending).rejects.toThrow(UserError);
    await expect(pending).rejects.toThrow(
      '"nobody@example.com" names no bitbucket.org account; use bitbucket:<nickname>',
    );
  });

  test("an unknown or ambiguous nickname fails setReviewers as a UserError", async () => {
    const unknownQuery = encodeURIComponent('user.nickname = "nobody"');
    const sharedQuery = encodeURIComponent('user.nickname = "carol"');
    stubBitbucket({
      [`GET ${REPO}/pullrequests/24?fields=reviewers.uuid%2Creviewers.nickname`]: { json: { reviewers: [] } },
      [`GET ${API}/workspaces/test-org/members?q=${unknownQuery}&pagelen=50`]: { json: page([]) },
      [`GET ${API}/workspaces/test-org/members?q=${sharedQuery}&pagelen=50`]: {
        json: page([{ user: { uuid: "{u-carol}" } }, { user: { uuid: "{u-imposter}" } }]),
      },
    });
    await expect(forge().setReviewers(forgeChangeId(24), [userName("bitbucket:nobody")], [])).rejects.toThrow(
      'no bitbucket.org account "nobody" in workspace test-org',
    );
    await expect(forge().setReviewers(forgeChangeId(24), [userName("bitbucket:carol")], [])).rejects.toThrow(
      'several accounts in workspace test-org share the nickname "carol"',
    );
  });

  test("a refused reviewer surfaces as a UserError naming the PR", async () => {
    const memberQuery = encodeURIComponent('user.nickname = "alice"');
    stubBitbucket({
      [`GET ${REPO}/pullrequests/25?fields=reviewers.uuid%2Creviewers.nickname`]: { json: { reviewers: [] } },
      [`GET ${API}/workspaces/test-org/members?q=${memberQuery}&pagelen=50`]: {
        json: page([{ user: { uuid: "{u-alice}" } }]),
      },
      [`PUT ${REPO}/pullrequests/25`]: {
        status: 400,
        json: { error: { message: "the author cannot review their own pull request" } },
      },
    });
    await expect(forge().setReviewers(forgeChangeId(25), [userName("bitbucket:alice")], [])).rejects.toThrow(
      /bitbucket\.org\/test-org\/widgets#25 reviewers not updated: .*author/,
    );
  });

  test("a failing request reports the status and Bitbucket's message", async () => {
    stubBitbucket({
      [`GET ${REPO}/pullrequests/404/comments?pagelen=50`]: {
        status: 404,
        json: { error: { message: "Resource not found" } },
      },
    });
    await expect(forge().listComments(forgeChangeId(404))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("Resource not found") as string,
    });
  });
});
