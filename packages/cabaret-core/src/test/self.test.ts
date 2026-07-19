import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeName,
  currentSelf,
  knownUsers,
  type LogEntry,
  parseBranchName,
  selfAs,
  timestampMs,
  userName,
} from "../index.js";

/** A backend of just an identity and its `cabaret.alias` config values. */
function configBackend(user: string, aliases: readonly string[]): Backend {
  const stub: Pick<Backend, "currentUser" | "configAll"> = {
    async currentUser() {
      return userName(user);
    },
    async configAll(key) {
      return key === "cabaret.alias" ? aliases : [];
    },
  };
  return stub as Backend;
}

test("currentSelf collects aliases, dropping duplicates and the user themselves", async () => {
  const backend = configBackend("alice@example.com", [
    "agent@example.com",
    "alice@example.com",
    "agent@example.com",
    "alice@work.example",
  ]);
  expect(await currentSelf(backend)).toEqual({
    user: userName("alice@example.com"),
    aliases: new Set([userName("agent@example.com"), userName("alice@work.example")]),
  });
});

test("currentSelf rejects an empty alias", async () => {
  const backend = configBackend("alice@example.com", [""]);
  await expect(currentSelf(backend)).rejects.toThrow("config cabaret.alias must be nonempty");
});

test("selfAs borrows another identity but resolves one's own to a plain self", async () => {
  const backend = configBackend("alice@example.com", ["agent@example.com"]);
  const own = await currentSelf(backend);
  expect(await selfAs(backend)).toEqual({ self: own, as: undefined });
  expect(await selfAs(backend, userName("alice@example.com"))).toEqual({ self: own, as: undefined });
  // An alias is borrowed like any other user: its obligations are its own.
  for (const raw of ["agent@example.com", "bob@example.com"]) {
    const borrowed = userName(raw);
    expect(await selfAs(backend, borrowed)).toEqual({
      self: { user: borrowed, aliases: new Set() },
      as: borrowed,
    });
  }
});

test("knownUsers collects writers, owners, and reviewers across all change logs", async () => {
  const at = timestampMs(1748000000000);
  const logs = new Map<ChangeName, readonly LogEntry[]>([
    [
      parseBranchName("widgets"),
      [
        {
          timestamp: at,
          user: userName("alice@example.com"),
          action: { kind: "set-parent", parent: parseBranchName("main") },
        },
        {
          timestamp: at,
          user: userName("alice@example.com"),
          action: { kind: "add-reviewer", reviewer: userName("carol@example.com") },
        },
        { timestamp: at, user: userName("dave@example.com"), action: { kind: "set-reviewing", reviewing: "everyone" } },
      ],
    ],
    [
      parseBranchName("gadget"),
      [
        {
          timestamp: at,
          user: userName("bob@example.com"),
          action: { kind: "set-parent", parent: parseBranchName("main") },
        },
        {
          timestamp: at,
          user: userName("bob@example.com"),
          action: { kind: "set-owner", owner: userName("erin@example.com") },
        },
      ],
    ],
  ]);
  const stub: Pick<Backend, "listChanges" | "readLog"> = {
    async listChanges() {
      return [...logs.keys()];
    },
    async readLog(change) {
      const entries = logs.get(change);
      if (entries === undefined) {
        throw new Error(`no log for ${change}`);
      }
      return entries;
    },
  };
  expect(await knownUsers(stub as Backend)).toEqual([
    "alice@example.com",
    "bob@example.com",
    "carol@example.com",
    "dave@example.com",
    "erin@example.com",
  ]);
});
