import { forgeChangeId, parseCommitHash, parseRefName, UserError } from "cabaret-core";
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
    await forge().setParent(forgeChangeId(12), parseRefName("develop"));
    expect(calls[0]?.headers.authorization).toBe("Bearer token-123");
  });

  test("getChange maps an open MR, using the author's public email", async () => {
    stubGitLab({
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 3 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: "alice@example.com" } } } },
      ],
    });
    expect(await forge().getChange(forgeChangeId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "alice@example.com",
      state: "open",
    });
  });

  test("getChange maps a true merge, falling back to the id-prefixed noreply identity", async () => {
    stubGitLab({
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: "89e6c98d92887913cadf06b2adb97f26cde4849b",
                  diffStatsSummary: { fileCount: 1 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/12", publicEmail: null } } } },
      ],
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
      author: "12-bob@users.noreply.gitlab.com",
      state: "merged",
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    });
  });

  test("a squash under the merge-commit method reports no reviewed ancestry", async () => {
    // The merge commit's second parent is the squash commit, not the head
    // that was reviewed, so `parents` is 1 despite the two-parent commit.
    stubGitLab({
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: "2222222222222222222222222222222222222222",
                  diffStatsSummary: { fileCount: 4 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/44", publicEmail: null } } } },
      ],
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
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 2 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/44", publicEmail: null } } } },
      ],
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

  test("getChange maps a closed, authorless MR to the ghost identity without a lookup", async () => {
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
                mergeCommitSha: null,
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
      author: "ghost@users.noreply.gitlab.com",
      state: "closed",
    });
    expect(calls).toHaveLength(1);
  });

  test("a locked MR reads as open", async () => {
    stubGitLab({
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 1 },
                },
              },
            },
          },
        },
        { json: { data: { user: null } } },
      ],
    });
    expect((await forge().getChange(forgeChangeId(13))).state).toBe("open");
  });

  test("an unknown username still maps to a stable noreply identity", async () => {
    stubGitLab({
      [GRAPHQL]: [
        {
          json: {
            data: {
              project: {
                mergeRequest: {
                  iid: "14",
                  sourceBranch: "old-work",
                  diffHeadSha: "778899aabbccddeeff0011223344556677889900",
                  targetBranch: "main",
                  title: "Old work",
                  author: { username: "vanished" },
                  state: "opened",
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 1 },
                },
              },
            },
          },
        },
        { json: { data: { user: null } } },
      ],
    });
    expect((await forge().getChange(forgeChangeId(14))).author).toBe("vanished@users.noreply.gitlab.com");
  });

  test("an externally merged MR without merge or squash commit lands its head", async () => {
    stubGitLab({
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 1 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/12", publicEmail: null } } } },
      ],
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
    await expect(forge().findChange(parseRefName("add-tables"))).rejects.toThrow(
      "no project test-org/widgets on gitlab.com, or the token cannot see it",
    );
  });

  test("findChange queries by source branch and maps the MR", async () => {
    const calls = stubGitLab({
      [GRAPHQL]: [
        {
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
                      mergeCommitSha: null,
                      diffStatsSummary: { fileCount: 3 },
                    },
                  ],
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: null } } } },
      ],
    });
    expect(await forge().findChange(parseRefName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "31-alice@users.noreply.gitlab.com",
      state: "open",
    });
    expect(graphqlVariables(calls)[0]).toEqual({ path: "test-org/widgets", branch: "add-tables" });
  });

  test("findChange is undefined when no open MR has the branch", async () => {
    stubGitLab({
      [GRAPHQL]: { json: { data: { project: { mergeRequests: { nodes: [] } } } } },
    });
    expect(await forge().findChange(parseRefName("orphan"))).toBeUndefined();
  });

  test("fetchOpenChanges follows the pagination cursor, carrying non-system notes and their cap", async () => {
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
                      mergeCommitSha: null,
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
                      sourceBranch: "second",
                      diffHeadSha: "23456789abcdef0123456789abcdef0123456789",
                      targetBranch: "first",
                      title: "Second",
                      author: { username: "bob" },
                      state: "opened",
                      mergeCommitSha: null,
                      notes: { nodes: [], pageInfo: { hasNextPage: false } },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "CUR1" },
                },
              },
            },
          },
        },
        // The first page's identities resolve while the second page is still
        // being fetched, so the user lookups land between the page queries.
        { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: null } } } },
        { json: { data: { user: { id: "gid://gitlab/User/12", publicEmail: null } } } },
        {
          json: {
            data: {
              project: {
                mergeRequests: {
                  nodes: [
                    {
                      iid: "6",
                      sourceBranch: "third",
                      diffHeadSha: "3456789abcdef0123456789abcdef0123456789a",
                      targetBranch: "main",
                      title: "Third",
                      author: { username: "alice" },
                      state: "opened",
                      mergeCommitSha: null,
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
    expect(await forge().fetchOpenChanges()).toEqual([
      {
        change: {
          id: 4,
          head: "first",
          tip: "123456789abcdef0123456789abcdef012345678",
          parent: "main",
          title: "First",
          author: "31-alice@users.noreply.gitlab.com",
          state: "open",
        },
        comments: [
          {
            id: "101",
            author: "12-bob@users.noreply.gitlab.com",
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
          author: "12-bob@users.noreply.gitlab.com",
          state: "open",
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
          author: "31-alice@users.noreply.gitlab.com",
          state: "open",
        },
        comments: [],
        commentsTruncated: true,
      },
    ]);
    expect(graphqlVariables(calls)).toEqual([
      { path: "test-org/widgets", cursor: null },
      { username: "alice" },
      { username: "bob" },
      { path: "test-org/widgets", cursor: "CUR1" },
    ]);
  });

  test("identities are looked up once per username", async () => {
    const calls = stubGitLab({
      [`GET ${PROJECT}/merge_requests/7/notes?sort=asc&per_page=100&page=1`]: {
        json: [
          { id: 101, author: { username: "alice" }, body: "first", system: false, updated_at: "2026-05-01T00:00:00Z" },
          {
            id: 102,
            author: { username: "alice" },
            body: "second",
            system: false,
            updated_at: "2026-05-02T12:30:00Z",
          },
        ],
      },
      [GRAPHQL]: { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: null } } } },
    });
    await forge().listComments(forgeChangeId(7));
    expect(calls.filter(({ url }) => url === GRAPHQL_URL)).toHaveLength(1);
  });

  test("createChange posts the MR and fetches it by iid", async () => {
    const calls = stubGitLab({
      [`POST ${PROJECT}/merge_requests`]: { status: 201, json: { iid: 12 } },
      [GRAPHQL]: [
        {
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
                  mergeCommitSha: null,
                  diffStatsSummary: { fileCount: 1 },
                },
              },
            },
          },
        },
        { json: { data: { user: { id: "gid://gitlab/User/9", publicEmail: null } } } },
      ],
    });
    const created = await forge().createChange(parseRefName("new-work"), parseRefName("parent-branch"), "New work");
    expect(created).toEqual({
      id: 12,
      head: "new-work",
      tip: "456789abcdef0123456789abcdef0123456789ab",
      parent: "parent-branch",
      title: "New work",
      author: "9-dave@users.noreply.gitlab.com",
      state: "open",
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({ source_branch: "new-work", target_branch: "parent-branch", title: "New work" }),
    );
  });

  test("setParent puts the MR's target branch", async () => {
    const calls = stubGitLab({
      [`PUT ${PROJECT}/merge_requests/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseRefName("develop"));
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
      [GRAPHQL]: [
        { json: { data: { user: { id: "gid://gitlab/User/31", publicEmail: "alice@example.com" } } } },
        { json: { data: { user: { id: "gid://gitlab/User/12", publicEmail: null } } } },
      ],
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      {
        id: "101",
        author: "alice@example.com",
        body: "first",
        updatedAt: Date.parse("2026-05-01T00:00:00Z"),
      },
      {
        id: "103",
        author: "12-bob@users.noreply.gitlab.com",
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
