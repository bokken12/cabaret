import { forgeChangeId, forgeCursor, parseBranchName, parseCommitHash, UserError, userName } from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitLabClient, parseGitLabRemote } from "../client.js";
import { GitLabForge } from "../forge.js";
import { type Call, stubGitLab } from "./stub.js";

describe("parseGitLabRemote", () => {
  test("accepts the URL forms git uses for gitlab.com", () => {
    expect(parseGitLabRemote("https://gitlab.com/test-org/widgets.git")).toEqual({ path: "test-org/widgets" });
    expect(parseGitLabRemote("https://gitlab.com/alice/dotfiles")).toEqual({ path: "alice/dotfiles" });
    expect(parseGitLabRemote("git@gitlab.com:test-org/widgets.git")).toEqual({ path: "test-org/widgets" });
    expect(parseGitLabRemote("ssh://git@gitlab.com/bob/tools.git")).toEqual({ path: "bob/tools" });
  });

  test("keeps every subgroup component of a nested project path", () => {
    expect(parseGitLabRemote("git@gitlab.com:test-org/platform/widgets.git")).toEqual({
      path: "test-org/platform/widgets",
    });
  });

  test("lowercases, so every spelling of one project yields one locator", () => {
    expect(parseGitLabRemote("https://GitLab.com/Test-Org/Widgets.git")).toEqual({ path: "test-org/widgets" });
  });

  test("rejects URLs that are not gitlab.com projects", () => {
    expect(() => parseGitLabRemote("https://github.com/test-org/widgets.git")).toThrow(UserError);
    expect(() => parseGitLabRemote("git@gitlab.com:widgets.git")).toThrow(UserError);
    expect(() => parseGitLabRemote("/home/alice/widgets")).toThrow(UserError);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://gitlab.com/api/v4";
const PROJECT = `${API}/projects/test-org%2Fwidgets`;
const GRAPHQL_URL = "https://gitlab.com/api/graphql";
const GRAPHQL = `POST ${GRAPHQL_URL}`;

function forge(): GitLabForge {
  return new GitLabForge(new GitLabClient("token-123", { throttled: false }), { path: "test-org/widgets" });
}

/** The variables each GraphQL call in `calls` sent, in call order. */
function graphqlVariables(calls: readonly Call[]): readonly unknown[] {
  return calls
    .filter(({ url }) => url === GRAPHQL_URL)
    .map(({ body }) => (JSON.parse(body ?? "{}") as { variables?: unknown }).variables);
}

describe("GitLabForge", () => {
  test("locator names the project", () => {
    expect(forge().locator).toBe("gitlab.com/test-org/widgets");
  });

  test("requests carry the token", async () => {
    const calls = stubGitLab({
      [`PUT ${PROJECT}/merge_requests/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.headers.authorization).toBe("Bearer token-123");
  });

  test("currentSelf is the token's account, its emails as aliases", async () => {
    stubGitLab({
      [`GET ${API}/user`]: {
        json: {
          username: "alice",
          email: "alice@example.com",
          public_email: "",
          commit_email: "31-alice@users.noreply.gitlab.com",
        },
      },
    });
    expect(await forge().currentSelf()).toEqual({
      user: "gitlab:alice",
      aliases: new Set(["alice@example.com", "31-alice@users.noreply.gitlab.com"]),
    });
  });

  test("getChange maps an open MR with its reviewers, sorted by identity", async () => {
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "7",
                sourceBranch: "add-tables",
                diffHeadSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                targetBranch: "main",
                title: "Add tables",
                author: { username: "alice" },
                state: "opened",
                draft: false,
                mergeCommitSha: null,
                reviewers: { nodes: [{ username: "carol" }, { username: "bob" }] },
                diffStatsSummary: { fileCount: 3 },
              },
            },
          },
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "gitlab:alice",
      state: "open",
      draft: false,
      reviewers: ["gitlab:bob", "gitlab:carol"],
    });
  });

  test("getChange maps a true merge", async () => {
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "8",
                sourceBranch: "fix-crash",
                diffHeadSha: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
                targetBranch: "release",
                title: "Fix crash",
                author: { username: "bob" },
                state: "merged",
                draft: false,
                mergeCommitSha: "89e6c98d92887913cadf06b2adb97f26cde4849b",
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 1 },
              },
            },
          },
        },
      },
      [`GET ${PROJECT}/repository/commits/89e6c98d92887913cadf06b2adb97f26cde4849b`]: {
        json: {
          parent_ids: ["1111111111111111111111111111111111111111", "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877"],
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(8))).toEqual({
      id: 8,
      head: "fix-crash",
      tip: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
      parent: "release",
      title: "Fix crash",
      author: "gitlab:bob",
      state: "merged",
      draft: false,
      reviewers: [],
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    });
  });

  test("a squash under the merge-commit method reports no reviewed ancestry", async () => {
    // The merge commit's second parent is the squash commit, not the head
    // that was reviewed, so `parents` is 1 despite the two-parent commit.
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "9",
                sourceBranch: "polish",
                diffHeadSha: "44556677889900aabbccddeeff112233445566aa",
                targetBranch: "main",
                title: "Polish",
                author: { username: "carol" },
                state: "merged",
                draft: false,
                mergeCommitSha: "2222222222222222222222222222222222222222",
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 4 },
              },
            },
          },
        },
      },
      [`GET ${PROJECT}/repository/commits/2222222222222222222222222222222222222222`]: {
        json: {
          parent_ids: ["1111111111111111111111111111111111111111", "3333333333333333333333333333333333333333"],
        },
      },
    });
    expect((await forge().getChange(forgeChangeId(9))).merge).toEqual({
      commit: "2222222222222222222222222222222222222222",
      parents: 1,
    });
  });

  test("a fast-forward squash lands the squash commit itself", async () => {
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "10",
                sourceBranch: "tidy",
                diffHeadSha: "5566778899aabbccddeeff001122334455667788",
                targetBranch: "main",
                title: "Tidy",
                author: { username: "carol" },
                state: "merged",
                draft: false,
                mergeCommitSha: null,
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 2 },
              },
            },
          },
        },
      },
      [`GET ${PROJECT}/merge_requests/10`]: {
        json: {
          merge_commit_sha: null,
          squash_commit_sha: "3333333333333333333333333333333333333333",
          sha: "5566778899aabbccddeeff001122334455667788",
        },
      },
      [`GET ${PROJECT}/repository/commits/3333333333333333333333333333333333333333`]: {
        json: { parent_ids: ["1111111111111111111111111111111111111111"] },
      },
    });
    expect((await forge().getChange(forgeChangeId(10))).merge).toEqual({
      commit: "3333333333333333333333333333333333333333",
      parents: 1,
    });
  });

  test("getChange maps a closed, authorless MR to the ghost identity", async () => {
    const calls = stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "11",
                sourceBranch: "abandoned",
                diffHeadSha: "44556677889900aabbccddeeff112233445566aa",
                targetBranch: "main",
                title: "Abandoned",
                author: null,
                state: "closed",
                draft: false,
                mergeCommitSha: null,
                reviewers: null,
                diffStatsSummary: { fileCount: 5 },
              },
            },
          },
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(11))).toEqual({
      id: 11,
      head: "abandoned",
      tip: "44556677889900aabbccddeeff112233445566aa",
      parent: "main",
      title: "Abandoned",
      author: "gitlab:ghost",
      state: "closed",
      draft: false,
      reviewers: [],
    });
    expect(calls).toHaveLength(1);
  });

  test("a locked MR reads as open", async () => {
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "13",
                sourceBranch: "landing",
                diffHeadSha: "66778899aabbccddeeff00112233445566778899",
                targetBranch: "main",
                title: "Landing",
                author: { username: "alice" },
                state: "locked",
                draft: false,
                mergeCommitSha: null,
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 1 },
              },
            },
          },
        },
      },
    });
    expect((await forge().getChange(forgeChangeId(13))).state).toBe("open");
  });

  test("an externally merged MR without merge or squash commit lands its head", async () => {
    stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "15",
                sourceBranch: "hotfix",
                diffHeadSha: "8899aabbccddeeff001122334455667788990011",
                targetBranch: "main",
                title: "Hotfix",
                author: { username: "bob" },
                state: "merged",
                draft: false,
                mergeCommitSha: null,
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 1 },
              },
            },
          },
        },
      },
      [`GET ${PROJECT}/merge_requests/15`]: {
        json: {
          merge_commit_sha: null,
          squash_commit_sha: null,
          sha: "8899aabbccddeeff001122334455667788990011",
        },
      },
      [`GET ${PROJECT}/repository/commits/8899aabbccddeeff001122334455667788990011`]: {
        json: { parent_ids: ["1111111111111111111111111111111111111111"] },
      },
    });
    expect((await forge().getChange(forgeChangeId(15))).merge).toEqual({
      commit: "8899aabbccddeeff001122334455667788990011",
      parents: 1,
    });
  });

  test("a missing merge request surfaces as a UserError, not a parse failure", async () => {
    stubGitLab({
      [GRAPHQL]: { json: { data: { project: { mergeRequest: null } } } },
    });
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(UserError);
    await expect(forge().getChange(forgeChangeId(99))).rejects.toThrow(
      "no merge request !99 on gitlab.com/test-org/widgets",
    );
  });

  test("an invisible project surfaces as a UserError naming it", async () => {
    stubGitLab({
      [GRAPHQL]: { json: { data: { project: null } } },
    });
    await expect(forge().findChange(parseBranchName("add-tables"))).rejects.toThrow(
      "no project test-org/widgets on gitlab.com, or the token cannot see it",
    );
  });

  test("findChange queries by source branch and maps the MR", async () => {
    const calls = stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequests: {
                nodes: [
                  {
                    iid: "7",
                    sourceBranch: "add-tables",
                    diffHeadSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                    targetBranch: "main",
                    title: "Add tables",
                    author: { username: "alice" },
                    state: "opened",
                    draft: false,
                    mergeCommitSha: null,
                    reviewers: { nodes: [] },
                    diffStatsSummary: { fileCount: 3 },
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(await forge().findChange(parseBranchName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "gitlab:alice",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(graphqlVariables(calls)[0]).toEqual({ path: "test-org/widgets", branch: "add-tables" });
  });

  test("findChange is undefined when no open MR has the branch", async () => {
    stubGitLab({
      [GRAPHQL]: { json: { data: { project: { mergeRequests: { nodes: [] } } } } },
    });
    expect(await forge().findChange(parseBranchName("orphan"))).toBeUndefined();
  });

  test("fetchChanges follows the pagination cursor, carrying non-system notes and their cap", async () => {
    const calls = stubGitLab({
      [GRAPHQL]: [
        {
          json: {
            data: {
              project: {
                mergeRequests: {
                  nodes: [
                    {
                      iid: "4",
                      sourceBranch: "first",
                      diffHeadSha: "123456789abcdef0123456789abcdef012345678",
                      targetBranch: "main",
                      title: "First",
                      author: { username: "alice" },
                      state: "opened",
                      draft: false,
                      updatedAt: "2026-05-02T10:00:00Z",
                      mergeCommitSha: null,
                      reviewers: { nodes: [] },
                      notes: {
                        nodes: [
                          {
                            id: "gid://gitlab/Note/101",
                            author: { username: "bob" },
                            body: "please take a look",
                            system: false,
                            updatedAt: "2026-05-01T00:00:00Z",
                          },
                          {
                            id: "gid://gitlab/Note/102",
                            author: { username: "gitlab-bot" },
                            body: "changed target branch from `main` to `develop`",
                            system: true,
                            updatedAt: "2026-05-02T00:00:00Z",
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                    {
                      iid: "5",
                      updatedAt: "2026-05-02T11:30:00Z",
                      sourceBranch: "second",
                      diffHeadSha: "23456789abcdef0123456789abcdef0123456789",
                      targetBranch: "first",
                      title: "Second",
                      author: { username: "bob" },
                      state: "opened",
                      draft: false,
                      mergeCommitSha: null,
                      reviewers: { nodes: [] },
                      notes: { nodes: [], pageInfo: { hasNextPage: false } },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "CUR1" },
                },
              },
            },
          },
        },
        {
          json: {
            data: {
              project: {
                mergeRequests: {
                  nodes: [
                    {
                      iid: "6",
                      updatedAt: "2026-05-01T09:00:00Z",
                      sourceBranch: "third",
                      diffHeadSha: "3456789abcdef0123456789abcdef0123456789a",
                      targetBranch: "main",
                      title: "Third",
                      author: { username: "alice" },
                      state: "opened",
                      draft: false,
                      mergeCommitSha: null,
                      reviewers: { nodes: [] },
                      notes: { nodes: [], pageInfo: { hasNextPage: true } },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });
    expect(await forge().fetchChanges(undefined)).toEqual({
      coverage: "open",
      cursor: String(Date.parse("2026-05-02T11:25:00Z")),
      changes: [
        {
          change: {
            id: 4,
            head: "first",
            tip: "123456789abcdef0123456789abcdef012345678",
            parent: "main",
            title: "First",
            author: "gitlab:alice",
            state: "open",
            draft: false,
            reviewers: [],
          },
          comments: [
            {
              id: "101",
              author: "gitlab:bob",
              body: "please take a look",
              updatedAt: Date.parse("2026-05-01T00:00:00Z"),
            },
          ],
          commentsTruncated: false,
        },
        {
          change: {
            id: 5,
            head: "second",
            tip: "23456789abcdef0123456789abcdef0123456789",
            parent: "first",
            title: "Second",
            author: "gitlab:bob",
            state: "open",
            draft: false,
            reviewers: [],
          },
          comments: [],
          commentsTruncated: false,
        },
        {
          change: {
            id: 6,
            head: "third",
            tip: "3456789abcdef0123456789abcdef0123456789a",
            parent: "main",
            title: "Third",
            author: "gitlab:alice",
            state: "open",
            draft: false,
            reviewers: [],
          },
          comments: [],
          commentsTruncated: true,
        },
      ],
    });
    expect(graphqlVariables(calls)).toEqual([
      { path: "test-org/widgets", first: 25, cursor: null },
      { path: "test-org/widgets", first: 50, cursor: "CUR1" },
    ]);
  });

  test("fetchChanges with a cursor asks the server for what moved since, keeping every state", async () => {
    const node = (iid: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
      iid,
      sourceBranch: `branch-${iid}`,
      diffHeadSha: `${iid.repeat(40).slice(0, 40)}`,
      targetBranch: "main",
      title: `Change ${iid}`,
      author: { username: "alice" },
      state: "opened",
      draft: false,
      updatedAt,
      mergeCommitSha: null,
      reviewers: { nodes: [] },
      notes: { nodes: [], pageInfo: { hasNextPage: false } },
      ...extra,
    });
    const calls = stubGitLab({
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequests: {
                nodes: [node("7", "2026-06-10T12:00:00Z", { state: "closed" }), node("4", "2026-06-10T09:00:00Z")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
    const since = Date.parse("2026-06-01T00:00:00Z");
    const sweep = await forge().fetchChanges(forgeCursor(String(since)));
    expect(sweep.coverage).toBe("since");
    expect(sweep.cursor).toBe(String(Date.parse("2026-06-10T11:55:00Z")));
    expect(sweep.changes.map(({ change }) => [change.id, change.state])).toEqual([
      [7, "closed"],
      [4, "open"],
    ]);
    expect(graphqlVariables(calls)).toEqual([
      { path: "test-org/widgets", updatedAfter: "2026-06-01T00:00:00.000Z", first: 25, cursor: null },
    ]);
  });

  test("createChange posts the MR and fetches it by iid", async () => {
    const calls = stubGitLab({
      [`POST ${PROJECT}/merge_requests`]: { status: 201, json: { iid: 12 } },
      [GRAPHQL]: {
        json: {
          data: {
            project: {
              mergeRequest: {
                iid: "12",
                sourceBranch: "new-work",
                diffHeadSha: "456789abcdef0123456789abcdef0123456789ab",
                targetBranch: "parent-branch",
                title: "New work",
                author: { username: "dave" },
                state: "opened",
                draft: false,
                mergeCommitSha: null,
                reviewers: { nodes: [] },
                diffStatsSummary: { fileCount: 1 },
              },
            },
          },
        },
      },
    });
    const created = await forge().createChange(
      parseBranchName("new-work"),
      parseBranchName("parent-branch"),
      "New work",
    );
    expect(created).toEqual({
      id: 12,
      head: "new-work",
      tip: "456789abcdef0123456789abcdef0123456789ab",
      parent: "parent-branch",
      title: "New work",
      author: "gitlab:dave",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({ source_branch: "new-work", target_branch: "parent-branch", title: "New work" }),
    );
  });

  test("setParent puts the MR's target branch", async () => {
    const calls = stubGitLab({
      [`PUT ${PROJECT}/merge_requests/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.body).toBe(JSON.stringify({ target_branch: "develop" }));
  });

  test("landChange merges at the validated tip and returns the verified merge commit", async () => {
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    const calls = stubGitLab({
      [`PUT ${PROJECT}/merge_requests/7/merge`]: {
        json: {
          merge_commit_sha: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          squash_commit_sha: null,
          sha: tip,
        },
      },
      [`GET ${PROJECT}/repository/commits/89e6c98d92887913cadf06b2adb97f26cde4849b`]: {
        json: { parent_ids: ["1111111111111111111111111111111111111111", tip] },
      },
    });
    expect(await forge().landChange(forgeChangeId(7), "merge", tip, "land: add-tables", "Cabaret-Landed: yes")).toEqual(
      { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    );
    expect(calls[0]?.body).toBe(
      JSON.stringify({
        squash: false,
        merge_commit_message: "land: add-tables\n\nCabaret-Landed: yes",
        squash_commit_message: "land: add-tables\n\nCabaret-Landed: yes",
        sha: tip,
      }),
    );
  });

  test("a merge the project's settings squashed reports no reviewed ancestry", async () => {
    // The project squashes despite `squash: false`: the merge commit's second
    // parent is the squash commit, not the validated tip, so the landing
    // reads as a squash and the caller freezes the tip accordingly.
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    stubGitLab({
      [`PUT ${PROJECT}/merge_requests/7/merge`]: {
        json: {
          merge_commit_sha: "89e6c98d92887913cadf06b2adb97f26cde4849b",
          squash_commit_sha: "3333333333333333333333333333333333333333",
          sha: tip,
        },
      },
      [`GET ${PROJECT}/repository/commits/89e6c98d92887913cadf06b2adb97f26cde4849b`]: {
        json: {
          parent_ids: ["1111111111111111111111111111111111111111", "3333333333333333333333333333333333333333"],
        },
      },
    });
    expect(await forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).toEqual({
      commit: "89e6c98d92887913cadf06b2adb97f26cde4849b",
      parents: 1,
    });
  });

  test("a fast-forward squash merge returns the squash commit", async () => {
    const tip = parseCommitHash("0f9e8d7c6b5a49382716053f4e3d2c1b0a998877");
    const calls = stubGitLab({
      [`PUT ${PROJECT}/merge_requests/8/merge`]: {
        json: {
          merge_commit_sha: null,
          squash_commit_sha: "3333333333333333333333333333333333333333",
          sha: tip,
        },
      },
      [`GET ${PROJECT}/repository/commits/3333333333333333333333333333333333333333`]: {
        json: { parent_ids: ["1111111111111111111111111111111111111111"] },
      },
    });
    expect(await forge().landChange(forgeChangeId(8), "squash", tip, "land: fix-crash", "body")).toEqual({
      commit: "3333333333333333333333333333333333333333",
      parents: 1,
    });
    expect((JSON.parse(calls[0]?.body ?? "{}") as { squash: boolean }).squash).toBe(true);
  });

  test("a moved head surfaces as a UserError naming the MR", async () => {
    stubGitLab({
      [`PUT ${PROJECT}/merge_requests/7/merge`]: {
        status: 409,
        json: { message: "SHA does not match HEAD of source branch" },
      },
    });
    const tip = parseCommitHash("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    await expect(forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).rejects.toThrow(UserError);
    await expect(forge().landChange(forgeChangeId(7), "merge", tip, "t", "m")).rejects.toThrow(
      /gitlab\.com\/test-org\/widgets!7 did not merge: .*SHA does not match/,
    );
  });

  test("listComments lists oldest first and drops system notes", async () => {
    stubGitLab({
      [`GET ${PROJECT}/merge_requests/7/notes?sort=asc&per_page=100&page=1`]: {
        json: [
          { id: 101, author: { username: "alice" }, body: "first", system: false, updated_at: "2026-05-01T00:00:00Z" },
          {
            id: 102,
            author: { username: "gitlab-bot" },
            body: "changed target branch from `main` to `develop`",
            system: true,
            updated_at: "2026-05-02T00:00:00Z",
          },
          { id: 103, author: { username: "bob" }, body: "second", system: false, updated_at: "2026-05-02T12:30:00Z" },
        ],
      },
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      {
        id: "101",
        author: "gitlab:alice",
        body: "first",
        updatedAt: Date.parse("2026-05-01T00:00:00Z"),
      },
      {
        id: "103",
        author: "gitlab:bob",
        body: "second",
        updatedAt: Date.parse("2026-05-02T12:30:00Z"),
      },
    ]);
  });

  test("addComment posts the body verbatim, marker included", async () => {
    const body = `ship it\n\n<!-- cabaret:${"ab".repeat(32)} -->`;
    const calls = stubGitLab({
      [`POST ${PROJECT}/merge_requests/7/notes`]: { status: 201, json: {} },
    });
    await forge().addComment(forgeChangeId(7), body);
    expect(calls[0]?.body).toBe(JSON.stringify({ body }));
  });

  test("setReviewers resolves every identity form and puts the edited reviewer list", async () => {
    const calls = stubGitLab({
      // Current reviewers: eve (5, removed below) and frank (7, kept).
      [`GET ${PROJECT}/merge_requests/21`]: { json: { reviewers: [{ id: 5 }, { id: 7 }] } },
      [GRAPHQL]: [
        { json: { data: { user: { id: "gid://gitlab/User/44", publicEmail: null } } } },
        { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: null } } } },
      ],
      [`PUT ${PROJECT}/merge_requests/21`]: { json: {} },
    });
    await forge().setReviewers(
      forgeChangeId(21),
      [
        userName("12-bob@users.noreply.gitlab.com"),
        userName("gitlab:carol"),
        userName("alice@users.noreply.gitlab.com"),
      ],
      [userName("5-eve@users.noreply.gitlab.com")],
    );
    expect(graphqlVariables(calls)).toEqual([{ username: "carol" }, { username: "alice" }]);
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      url: `${PROJECT}/merge_requests/21`,
      headers: { authorization: "Bearer token-123", "content-type": "application/json" },
      body: JSON.stringify({ reviewer_ids: [7, 12, 31, 44] }),
    });
  });

  test("setReviewers skips the write when the reviewer set is unchanged", async () => {
    const calls = stubGitLab({
      [`GET ${PROJECT}/merge_requests/22`]: { json: { reviewers: [{ id: 12 }] } },
    });
    // bob is already a reviewer and alice already is not.
    await forge().setReviewers(
      forgeChangeId(22),
      [userName("12-bob@users.noreply.gitlab.com")],
      [userName("31-alice@users.noreply.gitlab.com")],
    );
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${PROJECT}/merge_requests/22`]);
  });

  test("an identity that names no gitlab.com account fails setReviewers as a UserError", async () => {
    stubGitLab({
      [`GET ${PROJECT}/merge_requests/23`]: { json: { reviewers: [] } },
    });
    const pending = forge().setReviewers(forgeChangeId(23), [userName("nobody@example.com")], []);
    await expect(pending).rejects.toThrow(UserError);
    await expect(pending).rejects.toThrow('"nobody@example.com" names no gitlab.com account; use gitlab:<username>');
  });

  test("an account whose username vanished fails setReviewers as a UserError", async () => {
    stubGitLab({
      [`GET ${PROJECT}/merge_requests/24`]: { json: { reviewers: [] } },
      [GRAPHQL]: { json: { data: { user: null } } },
    });
    await expect(forge().setReviewers(forgeChangeId(24), [], [userName("gitlab:vanished")])).rejects.toThrow(
      'no gitlab.com account found for "gitlab:vanished"',
    );
  });

  test("setDraft toggles through the mergeRequestSetDraft mutation", async () => {
    const calls = stubGitLab({
      [GRAPHQL]: { json: { data: { mergeRequestSetDraft: { errors: [] } } } },
    });
    await forge().setDraft(forgeChangeId(12), true);
    expect(graphqlVariables(calls)).toEqual([{ path: "test-org/widgets", iid: "12", draft: true }]);
    expect(calls[0]?.body).toContain("mergeRequestSetDraft");
  });

  test("setDraft surfaces the mutation's errors", async () => {
    stubGitLab({
      [GRAPHQL]: { json: { data: { mergeRequestSetDraft: { errors: ["insufficient permissions"] } } } },
    });
    await expect(forge().setDraft(forgeChangeId(12), false)).rejects.toThrow(
      "gitlab.com/test-org/widgets!12 draft not updated: insufficient permissions",
    );
  });

  test("a failing request reports the status and GitLab's message", async () => {
    stubGitLab({
      [`GET ${PROJECT}/merge_requests/404/notes?sort=asc&per_page=100&page=1`]: {
        status: 404,
        json: { message: "404 Not Found" },
      },
    });
    await expect(forge().listComments(forgeChangeId(404))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("404 Not Found") as string,
    });
  });
});
