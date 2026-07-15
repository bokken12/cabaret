import { forgeChangeId, parseRefName, UserError, userName } from "cabaret-core";
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
    await forge().setParent(forgeChangeId(12), parseRefName("develop"));
    expect(calls[0]?.headers.authorization).toBe("token token-123");
  });

  test("getChange maps an open PR, using the author's public profile email", async () => {
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
      [`GET ${API}/users/alice`]: { json: { email: "alice@example.com" } },
    });
    expect(await forge().getChange(forgeChangeId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "alice@example.com",
      state: "open",
      draft: false,
      reviewers: [],
    });
  });

  test("getChange maps a merged PR, falling back to the noreply identity", async () => {
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
      [`GET ${API}/users/bob`]: { json: { email: null } },
    });
    expect(await forge().getChange(forgeChangeId(8))).toEqual({
      id: 8,
      head: "fix-crash",
      tip: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
      parent: "release",
      title: "Fix crash",
      author: "bob@users.noreply.github.com",
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
      [`GET ${API}/users/ghost`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await forge().getChange(forgeChangeId(9))).toEqual({
      id: 9,
      head: "abandoned",
      tip: "44556677889900aabbccddeeff112233445566aa",
      parent: "main",
      title: "Abandoned",
      author: "ghost@users.noreply.github.com",
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
      [`GET ${API}/users/alice`]: { json: { email: null } },
      [`GET ${API}/users/bob`]: { json: { email: null } },
      [`GET ${API}/users/carol`]: { json: { email: "carol@example.com" } },
    });
    expect(await forge().getChange(forgeChangeId(10))).toEqual({
      id: 10,
      head: "reviewed",
      tip: "5566778899aabbccddeeff00112233445566aabb",
      parent: "main",
      title: "Reviewed",
      author: "alice@users.noreply.github.com",
      state: "open",
      draft: false,
      reviewers: ["bob@users.noreply.github.com", "carol@example.com"],
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
      [`GET ${API}/users/alice`]: { json: { email: null } },
    });
    expect(await forge().findChange(parseRefName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      parent: "main",
      title: "Add tables",
      author: "alice@users.noreply.github.com",
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
    expect(await forge().findChange(parseRefName("orphan"))).toBeUndefined();
  });

  test("fetchOpenChanges follows the pagination cursor, carrying comments and their cap", async () => {
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
      [`GET ${API}/users/alice`]: { json: { email: null } },
      [`GET ${API}/users/bob`]: { json: { email: null } },
    });
    expect(await forge().fetchOpenChanges()).toEqual([
      {
        change: {
          id: 4,
          head: "first",
          tip: "123456789abcdef0123456789abcdef012345678",
          parent: "main",
          title: "First",
          author: "alice@users.noreply.github.com",
          state: "open",
          draft: false,
          reviewers: ["bob@users.noreply.github.com"],
        },
        comments: [
          {
            id: "101",
            author: "bob@users.noreply.github.com",
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
          author: "bob@users.noreply.github.com",
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
          author: "alice@users.noreply.github.com",
          state: "open",
          draft: false,
          reviewers: [],
        },
        comments: [],
        commentsTruncated: true,
      },
    ]);
    expect(graphqlVariables(calls)).toEqual([
      { owner: "test-org", repo: "widgets", cursor: null },
      { owner: "test-org", repo: "widgets", cursor: "CUR1" },
    ]);
  });

  test("identities are looked up once per login", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/issues/7/comments?per_page=100`]: {
        json: [
          { id: 101, user: { login: "alice" }, body: "first", updated_at: "2026-05-01T00:00:00Z" },
          { id: 102, user: { login: "alice" }, body: "second", updated_at: "2026-05-02T12:30:00Z" },
        ],
      },
      [`GET ${API}/users/alice`]: { json: { email: null } },
    });
    await forge().listComments(forgeChangeId(7));
    expect(calls.filter(({ url }) => url === `${API}/users/alice`)).toHaveLength(1);
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
      [`GET ${API}/users/dave`]: { json: { email: null } },
    });
    const created = await forge().createChange(
      parseRefName("new-work"),
      parseRefName("parent-branch"),
      "New work",
      false,
    );
    expect(created).toEqual({
      id: 12,
      head: "new-work",
      tip: "456789abcdef0123456789abcdef0123456789ab",
      parent: "parent-branch",
      title: "New work",
      author: "dave@users.noreply.github.com",
      state: "open",
      draft: false,
      reviewers: [],
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({ title: "New work", head: "new-work", base: "parent-branch", body: "", draft: false }),
    );
  });

  test("setParent patches the PR's base branch", async () => {
    const calls = stubGitHub({
      [`PATCH ${REPOS}/pulls/12`]: { json: {} },
    });
    await forge().setParent(forgeChangeId(12), parseRefName("develop"));
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
      [`GET ${API}/users/alice`]: { json: { email: "alice@example.com" } },
      [`GET ${API}/users/bob`]: { json: { email: null } },
    });
    expect(await forge().listComments(forgeChangeId(7))).toEqual([
      {
        id: "101",
        author: "alice@example.com",
        body: "first",
        updatedAt: Date.parse("2026-05-01T00:00:00Z"),
      },
      {
        id: "102",
        author: "bob@users.noreply.github.com",
        body: "second",
        updatedAt: Date.parse("2026-05-02T12:30:00Z"),
      },
      {
        id: "103",
        author: "alice@example.com",
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

  test("setReviewers maps identities to logins, unwrapping noreply and searching the rest", async () => {
    const search = `${API}/search/users?q=${encodeURIComponent("carol@example.com in:email")}`;
    const calls = stubGitHub({
      [`GET ${search}`]: { json: { items: [{ login: "carol" }] } },
      [`POST ${REPOS}/pulls/12/requested_reviewers`]: { status: 201, json: {} },
      [`GET ${REPOS}/pulls/12/requested_reviewers`]: { json: { users: [{ login: "erin" }], teams: [] } },
      [`DELETE ${REPOS}/pulls/12/requested_reviewers`]: { json: {} },
    });
    await forge().setReviewers(
      forgeChangeId(12),
      [userName("carol@example.com"), userName("12345+dave@users.noreply.github.com")],
      [userName("erin@users.noreply.github.com")],
    );
    expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "GET", url: search, body: undefined },
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
    await forge().setReviewers(forgeChangeId(12), [], [userName("erin@users.noreply.github.com")]);
    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${REPOS}/pulls/12/requested_reviewers` },
    ]);
  });

  test("setReviewers fails when no account claims the email, or several match the search", async () => {
    stubGitHub({
      [`GET ${API}/search/users?q=${encodeURIComponent("frank@example.com in:email")}`]: { json: { items: [] } },
    });
    const failure = forge().setReviewers(forgeChangeId(12), [userName("frank@example.com")], []);
    await expect(failure).rejects.toThrow(UserError);
    await expect(failure).rejects.toThrow('no github.com account found for "frank@example.com"');
    stubGitHub({
      [`GET ${API}/search/users?q=${encodeURIComponent("grace@example.com in:email")}`]: {
        json: { items: [{ login: "grace" }, { login: "gracie" }] },
      },
    });
    const ambiguous = forge().setReviewers(forgeChangeId(12), [userName("grace@example.com")], []);
    await expect(ambiguous).rejects.toThrow(UserError);
    await expect(ambiguous).rejects.toThrow('"grace@example.com" is ambiguous on github.com');
  });

  test("setReviewers surfaces GitHub's refusal of an unassignable reviewer", async () => {
    stubGitHub({
      [`POST ${REPOS}/pulls/12/requested_reviewers`]: {
        status: 422,
        json: { message: "Reviews may only be requested from collaborators." },
      },
    });
    const failure = forge().setReviewers(forgeChangeId(12), [userName("erin@users.noreply.github.com")], []);
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
