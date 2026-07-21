import { afterEach, describe, expect, test, vi } from "vitest";
import { GitLabClient } from "../client.js";
import { stubGitLab } from "./stub.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const API = "https://gitlab.com/api/v4";

describe("GitLabClient", () => {
  test("a rate limit is waited out once, honoring retry-after", async () => {
    vi.useFakeTimers();
    const calls = stubGitLab({
      [`GET ${API}/version`]: [
        { status: 429, retryAfter: "7", json: { message: "Too Many Requests" } },
        { json: { version: "18.0" } },
      ],
    });
    const pending = new GitLabClient("token-123").get("/version");
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await pending).toEqual({ version: "18.0" });
    expect(calls).toHaveLength(2);
  });

  test("a second rate limit on the same call fails, after the 60s default wait", async () => {
    vi.useFakeTimers();
    const calls = stubGitLab({
      [`GET ${API}/version`]: [
        { status: 429, json: { message: "Too Many Requests" } },
        { status: 429, json: { message: "Too Many Requests" } },
      ],
    });
    const outcome = new GitLabClient("token-123")
      .get("/version")
      .then(() => "resolved")
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });

  test("throttled: false surfaces a rate limit without waiting", async () => {
    const calls = stubGitLab({
      [`GET ${API}/version`]: { status: 429, json: { message: "Too Many Requests" } },
    });
    await expect(new GitLabClient("token-123", { throttled: false }).get("/version")).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toHaveLength(1);
  });

  test("GraphQL-level errors fail the call", async () => {
    stubGitLab({
      "POST https://gitlab.com/api/graphql": {
        json: { data: null, errors: [{ message: "Field 'nope' doesn't exist" }] },
      },
    });
    const client = new GitLabClient("token-123", { throttled: false });
    await expect(client.graphql("query { nope }", {})).rejects.toThrow("Field 'nope' doesn't exist");
  });

  test("a failure's structured message survives into the error", async () => {
    stubGitLab({
      [`GET ${API}/projects/1`]: { status: 400, json: { message: { base: ["is invalid"] } } },
    });
    await expect(new GitLabClient("token-123", { throttled: false }).get("/projects/1")).rejects.toThrow(
      '{"base":["is invalid"]}',
    );
  });

  test("getPaginated refuses a non-list endpoint", async () => {
    stubGitLab({
      [`GET ${API}/projects/1?per_page=100&page=1`]: { json: {} },
    });
    const client = new GitLabClient("token-123", { throttled: false });
    await expect(client.getPaginated("/projects/1")).rejects.toThrow("not a list endpoint: /projects/1");
  });
});
