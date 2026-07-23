import { forgeChangeId, forgeCursor, parseBranchName, UserError, userName } from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { githubClient, parseGitHubRemote } from "../client.js";
import { GitHubForge } from "../forge.js";
import { type Call, stubGitHub } from "./stub.js";

describe("parseGitHubRemote", () => {
  test("accepts the URL forms git uses for github.com", () => {
    expect(parseGitHubRemote("https://github.com/test-org/widgets.git")).toEqual({
      owner: "test-org",
      repo: "widgets",
    });
    expect(parseGitHubRemote("https://github.com/alice/dotfiles")).toEqual({ owner: "alice", repo: "dotfiles" });
    expect(parseGitHubRemote("git@github.com:test-org/widgets.git")).toEqual({ owner: "test-org", repo: "widgets" });
    expect(parseGitHubRemote("ssh://git@github.com/bob/tools.git")).toEqual({ owner: "bob", repo: "tools" });
  });

  test("lowercases, so every spelling of one repository yields one locator", () => {
    expect(parseGitHubRemote("https://GitHub.com/Test-Org/Widgets.git")).toEqual({
      owner: "test-org",
      repo: "widgets",
    });
  });

  test("rejects URLs that are not github.com repositories", () => {
    expect(() => parseGitHubRemote("https://gitlab.com/test-org/widgets.git")).toThrow(UserError);
    expect(() => parseGitHubRemote("git@github.com:widgets.git")).toThrow(UserError);
    expect(() => parseGitHubRemote("/home/alice/widgets")).toThrow(UserError);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://api.github.com";
const REPOS = `${API}/repos/test-org/widgets`;
const GRAPHQL = `POST ${API}/graphql`;

/** The reviewer fields of a PR node nobody was asked to review. */
const NO_REVIEWERS = { reviewRequests: { nodes: [] }, latestReviews: { nodes: [] } };

function forge(): GitHubForge {
  return new GitHubForge(githubClient("token-123", { throttled: false }), { owner: "test-org", repo: "widgets" });
}

/** The variables each GraphQL call in `calls` sent, in call order. */
function graphqlVariables(calls: readonly Call[]): readonly unknown[] {
  return calls
    .filter(({ url }) => url === `${API}/graphql`)
    .map(({ body }) => (JSON.parse(body ?? "{}") as { variables?: unknown }).variables);
}

describe("GitHubForge", () => {
  test("locator names the repository", () => {
    expect(forge().locator).toBe("github.com/test-org/widgets");
  });

  test("requests carry the token", async () => {
    const calls = stubGitHub({
      [`PATCH ${REPOS}/pulls/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.headers.authorization).toBe("token token-123");
  });

  test("currentSelf is the token's account, its public email an alias", async () => {
    stubGitHub({
      [`GET ${API}/user`]: { json: { login: "alice", email: "alice@example.com" } },
    });
    expect(await forge().currentSelf()).toEqual({ user: "github:alice", aliases: new Set(["alice@example.com"]) });
  });

  test("currentSelf of an account with no public email has no aliases", async () => {
    stubGitHub({
      [`GET ${API}/user`]: { json: { login: "bob", email: null } },
    });
    expect(await forge().currentSelf()).toEqual({ user: "github:bob", aliases: new Set() });
  });

  test("getChange maps an open PR", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 7,
                id: "PR_node7",
                isDraft: false,
                headRefName: "add-tables",
                headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                baseRefName: "main",
                title: "Add tables",
                author: { login: "alice" },
                state: "OPEN",
                mergeCommit: null,
                ...NO_REVIEWERS,
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
      author: "github:alice",
      state: "open",
      draft: false,
      reviewers: [],
    });
  });

  test("getChange maps a merged PR", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 8,
                id: "PR_node8",
                isDraft: false,
                headRefName: "fix-crash",
                headRefOid: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
                baseRefName: "release",
                title: "Fix crash",
                author: { login: "bob" },
                state: "MERGED",
                mergeCommit: { oid: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: { totalCount: 2 } },
                ...NO_REVIEWERS,
              },
            },
          },
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(8))).toEqual({
      id: 8,
      head: "fix-crash",
      tip: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
      parent: "release",
      title: "Fix crash",
      author: "github:bob",
      state: "merged",
      draft: false,
      reviewers: [],
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
    });
  });

  test("getChange maps a closed PR by a deleted account", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 9,
                id: "PR_node9",
                isDraft: false,
                headRefName: "abandoned",
                headRefOid: "44556677889900aabbccddeeff112233445566aa",
                baseRefName: "main",
                title: "Abandoned",
                author: null,
                state: "CLOSED",
                mergeCommit: null,
                ...NO_REVIEWERS,
              },
            },
          },
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(9))).toEqual({
      id: 9,
      head: "abandoned",
      tip: "44556677889900aabbccddeeff112233445566aa",
      parent: "main",
      title: "Abandoned",
      author: "github:ghost",
      state: "closed",
      draft: false,
      reviewers: [],
    });
  });

  test("getChange unions pending requests with submitted reviews, skipping teams and deleted accounts", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 10,
                id: "PR_node10",
                isDraft: false,
                headRefName: "reviewed",
                headRefOid: "5566778899aabbccddeeff00112233445566aabb",
                baseRefName: "main",
                title: "Reviewed",
                author: { login: "alice" },
                state: "OPEN",
                mergeCommit: null,
                // A team request yields an empty node from the User fragment;
                // GraphQL admits null too.
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { login: "carol" } },
                    { requestedReviewer: {} },
                    { requestedReviewer: null },
                  ],
                },
                // carol both requested and reviewed: deduplicated. A deleted
                // account's review has no author: skipped.
                latestReviews: {
                  nodes: [{ author: { login: "bob" } }, { author: { login: "carol" } }, { author: null }],
                },
              },
            },
          },
        },
      },
    });
    expect(await forge().getChange(forgeChangeId(10))).toEqual({
      id: 10,
      head: "reviewed",
      tip: "5566778899aabbccddeeff00112233445566aabb",
      parent: "main",
      title: "Reviewed",
      author: "github:alice",
      state: "open",
      draft: false,
      reviewers: ["github:bob", "github:carol"],
    });
  });

  test("findChange queries by head branch and maps the PR", async () => {
    const calls = stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 7,
                    id: "PR_node7",
                    isDraft: false,
                    headRefName: "add-tables",
                    headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                    baseRefName: "main",
                    title: "Add tables",
                    author: { login: "alice" },
                    state: "OPEN",
                    mergeCommit: null,
                    ...NO_REVIEWERS,
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
      author: "github:alice",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(graphqlVariables(calls)).toEqual([{ owner: "test-org", repo: "widgets", branch: "add-tables" }]);
  });

  test("findChange is undefined when no open PR has the branch", async () => {
    stubGitHub({
      [GRAPHQL]: { json: { data: { repository: { pullRequests: { nodes: [] } } } } },
    });
    expect(await forge().findChange(parseBranchName("orphan"))).toBeUndefined();
  });

  test("fetchChanges follows the pagination cursor, carrying comments and their cap", async () => {
    const calls = stubGitHub({
      [GRAPHQL]: [
        {
          json: {
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      number: 4,
                      id: "PR_node4",
                      isDraft: false,
                      headRefName: "first",
                      headRefOid: "123456789abcdef0123456789abcdef012345678",
                      baseRefName: "main",
                      title: "First",
                      author: { login: "alice" },
                      state: "OPEN",
                      updatedAt: "2026-05-02T10:00:00Z",
                      mergeCommit: null,
                      reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }] },
                      latestReviews: { nodes: [] },
                      comments: {
                        nodes: [
                          {
                            databaseId: 101,
                            author: { login: "bob" },
                            body: "please take a look",
                            updatedAt: "2026-05-01T00:00:00Z",
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                    {
                      number: 5,
                      id: "PR_node5",
                      isDraft: false,
                      headRefName: "second",
                      headRefOid: "23456789abcdef0123456789abcdef0123456789",
                      baseRefName: "first",
                      title: "Second",
                      author: { login: "bob" },
                      state: "OPEN",
                      updatedAt: "2026-05-02T11:30:00Z",
                      mergeCommit: null,
                      ...NO_REVIEWERS,
                      comments: { nodes: [], pageInfo: { hasNextPage: false } },
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
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      number: 6,
                      id: "PR_node6",
                      isDraft: false,
                      headRefName: "third",
                      headRefOid: "3456789abcdef0123456789abcdef0123456789a",
                      baseRefName: "main",
                      title: "Third",
                      author: { login: "alice" },
                      state: "OPEN",
                      updatedAt: "2026-05-01T09:00:00Z",
                      mergeCommit: null,
                      ...NO_REVIEWERS,
                      comments: { nodes: [], pageInfo: { hasNextPage: true } },
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
            author: "github:alice",
            state: "open",
            draft: false,
            reviewers: ["github:bob"],
          },
          comments: [
            {
              id: "101",
              author: "github:bob",
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
            author: "github:bob",
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
            author: "github:alice",
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
      { owner: "test-org", repo: "widgets", first: 25, cursor: null },
      { owner: "test-org", repo: "widgets", first: 50, cursor: "CUR1" },
    ]);
  });

  test("fetchChanges with a cursor walks recency order, keeping every state, until it falls below", async () => {
    const node = (number: number, updatedAt: string, extra: Record<string, unknown> = {}) => ({
      number,
      id: `PR_node${number}`,
      isDraft: false,
      headRefName: `branch-${number}`,
      headRefOid: `${number}${"0".repeat(39)}`,
      baseRefName: "main",
      title: `Change ${number}`,
      author: { login: "alice" },
      state: "OPEN",
      updatedAt,
      mergeCommit: null,
      ...NO_REVIEWERS,
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      ...extra,
    });
    const calls = stubGitHub({
      [GRAPHQL]: [
        {
          json: {
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    node(7, "2026-06-10T12:00:00Z", {
                      state: "MERGED",
                      mergeCommit: { oid: "7".repeat(40), parents: { totalCount: 2 } },
                    }),
                    node(4, "2026-06-10T09:00:00Z"),
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
              repository: {
                pullRequests: {
                  // The stamp equal to the cursor re-reads (absorption is
                  // idempotent); the one below it ends the walk with pages
                  // still unread.
                  nodes: [node(5, "2026-06-01T00:00:00Z"), node(6, "2026-05-20T00:00:00Z")],
                  pageInfo: { hasNextPage: true, endCursor: "CUR2" },
                },
              },
            },
          },
        },
      ],
    });
    const since = String(Date.parse("2026-06-01T00:00:00Z"));
    const sweep = await forge().fetchChanges(forgeCursor(since));
    expect(sweep.coverage).toBe("since");
    expect(sweep.cursor).toBe(String(Date.parse("2026-06-10T11:55:00Z")));
    expect(sweep.changes.map(({ change }) => [change.id, change.state])).toEqual([
      [7, "merged"],
      [4, "open"],
      [5, "open"],
    ]);
    expect(sweep.changes[0]?.change.merge).toEqual({ commit: "7".repeat(40), parents: 2 });
    const bodies = calls.map(({ body }) => (JSON.parse(body ?? "{}") as { query?: string }).query ?? "");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("orderBy: {field: UPDATED_AT, direction: DESC}");
    expect(bodies[0]).not.toContain("states: OPEN");
  });

  test("createChange posts the PR and fetches it by number", async () => {
    const calls = stubGitHub({
      [`POST ${REPOS}/pulls`]: { status: 201, json: { number: 12 } },
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 12,
                id: "PR_node12",
                isDraft: false,
                headRefName: "new-work",
                headRefOid: "456789abcdef0123456789abcdef0123456789ab",
                baseRefName: "parent-branch",
                title: "New work",
                author: { login: "dave" },
                state: "OPEN",
                mergeCommit: null,
                ...NO_REVIEWERS,
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
      author: "github:dave",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({ title: "New work", head: "new-work", base: "parent-branch", body: "" }),
    );
  });

  test("setParent patches the PR's base branch", async () => {
    const calls = stubGitHub({
      [`PATCH ${REPOS}/pulls/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseBranchName("develop"));
    expect(calls[0]?.body).toBe(JSON.stringify({ base: "develop" }));
  });

  test("listComments follows Link pagination, oldest first", async () => {
    const page2 = `${API}/repositories/555/issues/7/comments?per_page=100&page=2`;
    stubGitHub({
      [`GET ${REPOS}/issues/7/comments?per_page=100`]: {
        json: [
          { id: 101, user: { login: "alice" }, body: "first", updated_at: "2026-05-01T00:00:00Z" },
          { id: 102, user: { login: "bob" }, body: "second", updated_at: "2026-05-02T12:30:00Z" },
        ],
        link: `<${page2}>; rel="next", <${page2}>; rel="last"`,
      },
      [`GET ${page2}`]: {
        json: [{ id: 103, user: { login: "alice" }, body: "third", updated_at: "2026-05-03T08:15:00Z" }],
      },
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      {
        id: "101",
        author: "github:alice",
        body: "first",
        updatedAt: Date.parse("2026-05-01T00:00:00Z"),
      },
      {
        id: "102",
        author: "github:bob",
        body: "second",
        updatedAt: Date.parse("2026-05-02T12:30:00Z"),
      },
      {
        id: "103",
        author: "github:alice",
        body: "third",
        updatedAt: Date.parse("2026-05-03T08:15:00Z"),
      },
    ]);
  });

  test("addComment posts the body verbatim, marker included", async () => {
    const body = `ship it\n\n<!-- cabaret:${"ab".repeat(32)} -->`;
    const calls = stubGitHub({
      [`POST ${REPOS}/issues/7/comments`]: { status: 201, json: {} },
    });
    await forge().addComment(forgeChangeId(7), body);
    expect(calls[0]?.body).toBe(JSON.stringify({ body }));
  });

  test("setReviewers maps identities to logins, unwrapping noreply email forms", async () => {
    const calls = stubGitHub({
      [`POST ${REPOS}/pulls/12/requested_reviewers`]: { status: 201, json: {} },
      [`GET ${REPOS}/pulls/12/requested_reviewers`]: { json: { users: [{ login: "erin" }], teams: [] } },
      [`DELETE ${REPOS}/pulls/12/requested_reviewers`]: { json: {} },
    });
    await forge().setReviewers(
      forgeChangeId(12),
      [userName("github:carol"), userName("12345+dave@users.noreply.github.com")],
      [userName("erin@users.noreply.github.com")],
    );
    expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "POST",
        url: `${REPOS}/pulls/12/requested_reviewers`,
        body: JSON.stringify({ reviewers: ["carol", "dave"] }),
      },
      { method: "GET", url: `${REPOS}/pulls/12/requested_reviewers`, body: undefined },
      { method: "DELETE", url: `${REPOS}/pulls/12/requested_reviewers`, body: JSON.stringify({ reviewers: ["erin"] }) },
    ]);
  });

  test("setReviewers withdraws only pending requests: a reviewer who reviewed is left alone", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/pulls/12/requested_reviewers`]: { json: { users: [], teams: [] } },
    });
    await forge().setReviewers(forgeChangeId(12), [], [userName("github:erin")]);
    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${REPOS}/pulls/12/requested_reviewers` },
    ]);
  });

  test("setReviewers fails for an identity that names no account", async () => {
    stubGitHub({});
    const failure = forge().setReviewers(forgeChangeId(12), [userName("frank@example.com")], []);
    await expect(failure).rejects.toThrow(UserError);
    await expect(failure).rejects.toThrow('"frank@example.com" names no github.com account; use github:<login>');
  });

  test("setReviewers surfaces GitHub's refusal of an unassignable reviewer", async () => {
    stubGitHub({
      [`POST ${REPOS}/pulls/12/requested_reviewers`]: {
        status: 422,
        json: { message: "Reviews may only be requested from collaborators." },
      },
    });
    const failure = forge().setReviewers(forgeChangeId(12), [userName("github:erin")], []);
    await expect(failure).rejects.toThrow(UserError);
    await expect(failure).rejects.toThrow(/^github\.com\/test-org\/widgets#12 reviewers not updated: .*collaborators/);
  });

  test("setDraft looks up the node id and converts through the matching mutation", async () => {
    const pr = {
      number: 7,
      id: "PR_node7",
      isDraft: false,
      headRefName: "add-tables",
      headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseRefName: "main",
      title: "Add tables",
      author: { login: "alice" },
      state: "OPEN",
      mergeCommit: null,
      ...NO_REVIEWERS,
    };
    const calls = stubGitHub({
      [GRAPHQL]: [
        { json: { data: { repository: { pullRequest: pr } } } },
        { json: { data: { convertPullRequestToDraft: { clientMutationId: null } } } },
      ],
    });
    await forge().setDraft(forgeChangeId(7), true);
    expect(graphqlVariables(calls)).toEqual([{ owner: "test-org", repo: "widgets", number: 7 }, { id: "PR_node7" }]);
    expect(calls[1]?.body).toContain("convertPullRequestToDraft");
  });

  test("setDraft is a no-op when the forge already agrees", async () => {
    const pr = {
      number: 7,
      id: "PR_node7",
      isDraft: true,
      headRefName: "add-tables",
      headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseRefName: "main",
      title: "Add tables",
      author: { login: "alice" },
      state: "OPEN",
      mergeCommit: null,
      ...NO_REVIEWERS,
    };
    const calls = stubGitHub({
      [GRAPHQL]: { json: { data: { repository: { pullRequest: pr } } } },
    });
    await forge().setDraft(forgeChangeId(7), true);
    expect(calls).toHaveLength(1);
  });

  test("a failing request reports the status and GitHub's message", async () => {
    stubGitHub({
      [`GET ${REPOS}/issues/404/comments?per_page=100`]: { status: 404, json: { message: "Not Found" } },
    });
    await expect(forge().listComments(forgeChangeId(404))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("Not Found"),
    });
  });
});
