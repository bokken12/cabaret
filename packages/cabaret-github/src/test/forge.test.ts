import { forgeRequestId, parseRefName, UserError } from "cabaret-core";
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
    await forge().setBase(forgeRequestId(12), parseRefName("develop"));
    expect(calls[0]?.headers.authorization).toBe("token token-123");
  });

  test("getRequest maps an open request, using the author's public profile email", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 7,
                headRefName: "add-tables",
                headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                baseRefName: "main",
                title: "Add tables",
                author: { login: "alice" },
                state: "OPEN",
                mergeCommit: null,
                changedFiles: 3,
              },
            },
          },
        },
      },
      [`GET ${API}/users/alice`]: { json: { email: "alice@example.com" } },
    });
    expect(await forge().getRequest(forgeRequestId(7))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      base: "main",
      title: "Add tables",
      author: "alice@example.com",
      state: "open",
      changedFiles: 3,
    });
  });

  test("getRequest maps a merged request, falling back to the noreply identity", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 8,
                headRefName: "fix-crash",
                headRefOid: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
                baseRefName: "release",
                title: "Fix crash",
                author: { login: "bob" },
                state: "MERGED",
                mergeCommit: { oid: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: { totalCount: 2 } },
                changedFiles: 1,
              },
            },
          },
        },
      },
      [`GET ${API}/users/bob`]: { json: { email: null } },
    });
    expect(await forge().getRequest(forgeRequestId(8))).toEqual({
      id: 8,
      head: "fix-crash",
      tip: "0f9e8d7c6b5a49382716053f4e3d2c1b0a998877",
      base: "release",
      title: "Fix crash",
      author: "bob@users.noreply.github.com",
      state: "merged",
      merge: { commit: "89e6c98d92887913cadf06b2adb97f26cde4849b", parents: 2 },
      changedFiles: 1,
    });
  });

  test("getRequest maps a closed request by a deleted account", async () => {
    stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 9,
                headRefName: "abandoned",
                headRefOid: "44556677889900aabbccddeeff112233445566aa",
                baseRefName: "main",
                title: "Abandoned",
                author: null,
                state: "CLOSED",
                mergeCommit: null,
                changedFiles: 5,
              },
            },
          },
        },
      },
      [`GET ${API}/users/ghost`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await forge().getRequest(forgeRequestId(9))).toEqual({
      id: 9,
      head: "abandoned",
      tip: "44556677889900aabbccddeeff112233445566aa",
      base: "main",
      title: "Abandoned",
      author: "ghost@users.noreply.github.com",
      state: "closed",
      changedFiles: 5,
    });
  });

  test("findRequest queries by head branch and maps the request", async () => {
    const calls = stubGitHub({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 7,
                    headRefName: "add-tables",
                    headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
                    baseRefName: "main",
                    title: "Add tables",
                    author: { login: "alice" },
                    state: "OPEN",
                    mergeCommit: null,
                    changedFiles: 3,
                  },
                ],
              },
            },
          },
        },
      },
      [`GET ${API}/users/alice`]: { json: { email: null } },
    });
    expect(await forge().findRequest(parseRefName("add-tables"))).toEqual({
      id: 7,
      head: "add-tables",
      tip: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      base: "main",
      title: "Add tables",
      author: "alice@users.noreply.github.com",
      state: "open",
      changedFiles: 3,
    });
    expect(graphqlVariables(calls)).toEqual([{ owner: "test-org", repo: "widgets", branch: "add-tables" }]);
  });

  test("findRequest is undefined when no open request has the branch", async () => {
    stubGitHub({
      [GRAPHQL]: { json: { data: { repository: { pullRequests: { nodes: [] } } } } },
    });
    expect(await forge().findRequest(parseRefName("orphan"))).toBeUndefined();
  });

  test("fetchSnapshot follows the pagination cursor, carrying files and comments", async () => {
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
                      headRefName: "first",
                      headRefOid: "123456789abcdef0123456789abcdef012345678",
                      baseRefName: "main",
                      title: "First",
                      author: { login: "alice" },
                      state: "OPEN",
                      mergeCommit: null,
                      changedFiles: 2,
                      files: { nodes: [{ path: "src/app.ts" }, { path: "docs/guide.md" }] },
                      comments: {
                        nodes: [
                          {
                            databaseId: 101,
                            author: { login: "bob" },
                            body: "please take a look",
                            updatedAt: "2026-05-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                    {
                      number: 5,
                      headRefName: "second",
                      headRefOid: "23456789abcdef0123456789abcdef0123456789",
                      baseRefName: "first",
                      title: "Second",
                      author: { login: "bob" },
                      state: "OPEN",
                      mergeCommit: null,
                      changedFiles: 1,
                      files: { nodes: [{ path: "widgets.sql" }] },
                      comments: { nodes: [] },
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
                      headRefName: "third",
                      headRefOid: "3456789abcdef0123456789abcdef0123456789a",
                      baseRefName: "main",
                      title: "Third",
                      author: { login: "alice" },
                      state: "OPEN",
                      mergeCommit: null,
                      changedFiles: 9,
                      files: null,
                      comments: { nodes: [] },
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
    expect(await forge().fetchSnapshot()).toEqual([
      {
        request: {
          id: 4,
          head: "first",
          tip: "123456789abcdef0123456789abcdef012345678",
          base: "main",
          title: "First",
          author: "alice@users.noreply.github.com",
          state: "open",
          changedFiles: 2,
        },
        files: ["src/app.ts", "docs/guide.md"],
        comments: [
          {
            id: "101",
            author: "bob@users.noreply.github.com",
            body: "please take a look",
            updatedAt: Date.parse("2026-05-01T00:00:00Z"),
          },
        ],
      },
      {
        request: {
          id: 5,
          head: "second",
          tip: "23456789abcdef0123456789abcdef0123456789",
          base: "first",
          title: "Second",
          author: "bob@users.noreply.github.com",
          state: "open",
          changedFiles: 1,
        },
        files: ["widgets.sql"],
        comments: [],
      },
      {
        request: {
          id: 6,
          head: "third",
          tip: "3456789abcdef0123456789abcdef0123456789a",
          base: "main",
          title: "Third",
          author: "alice@users.noreply.github.com",
          state: "open",
          changedFiles: 9,
        },
        files: [],
        comments: [],
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
    await forge().listComments(forgeRequestId(7));
    expect(calls.filter(({ url }) => url === `${API}/users/alice`)).toHaveLength(1);
  });

  test("createRequest posts the request and fetches it by number", async () => {
    const calls = stubGitHub({
      [`POST ${REPOS}/pulls`]: { status: 201, json: { number: 12 } },
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequest: {
                number: 12,
                headRefName: "new-work",
                headRefOid: "456789abcdef0123456789abcdef0123456789ab",
                baseRefName: "parent-branch",
                title: "New work",
                author: { login: "dave" },
                state: "OPEN",
                mergeCommit: null,
                changedFiles: 1,
              },
            },
          },
        },
      },
      [`GET ${API}/users/dave`]: { json: { email: null } },
    });
    const created = await forge().createRequest(parseRefName("new-work"), parseRefName("parent-branch"), "New work");
    expect(created).toEqual({
      id: 12,
      head: "new-work",
      tip: "456789abcdef0123456789abcdef0123456789ab",
      base: "parent-branch",
      title: "New work",
      author: "dave@users.noreply.github.com",
      state: "open",
      changedFiles: 1,
    });
    expect(calls[0]?.body).toBe(
      JSON.stringify({ title: "New work", head: "new-work", base: "parent-branch", body: "" }),
    );
  });

  test("setBase patches the request's base branch", async () => {
    const calls = stubGitHub({
      [`PATCH ${REPOS}/pulls/12`]: { json: {} },
    });
    await forge().setBase(forgeRequestId(12), parseRefName("develop"));
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
    expect(await forge().listComments(forgeRequestId(7))).toEqual([
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
    await forge().addComment(forgeRequestId(7), body);
    expect(calls[0]?.body).toBe(JSON.stringify({ body }));
  });

  test("a failing request reports the status and GitHub's message", async () => {
    stubGitHub({
      [`GET ${REPOS}/issues/404/comments?per_page=100`]: { status: 404, json: { message: "Not Found" } },
    });
    await expect(forge().listComments(forgeRequestId(404))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("Not Found"),
    });
  });
});
