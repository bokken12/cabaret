import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeId,
  type LogEntry,
  parseBranchName,
  parseChangeId,
  parseCommitHash,
  resolveChain,
  timestampMs,
  userName,
} from "../index.js";

/** The id the `index`th log of a `logBackend` is keyed by. */
function changeId(index: number): ChangeId {
  return parseChangeId((index + 1).toString(16).padStart(32, "0"));
}

/** A backend of just the given logs, keyed by `changeId` of each log's position; only the members `resolveChain` touches exist. */
function logBackend(logs: Record<string, readonly LogEntry[]>): Backend {
  const byId = new Map(Object.keys(logs).map((name, index) => [changeId(index), name] as const));
  const stub: Pick<Backend, "listChanges" | "readLog"> = {
    async listChanges() {
      return [...byId.keys()];
    },
    async readLog(change) {
      const name = byId.get(change);
      return (name === undefined ? undefined : logs[name]) ?? [];
    },
  };
  return stub as Backend;
}

/** The log entries `create` writes: a name, a parent, a base, and an owner. */
function created(name: string, parent: string, at: number): readonly LogEntry[] {
  const user = userName("alice@example.com");
  return [
    { timestamp: timestampMs(at), user, action: { kind: "set-name", name: parseBranchName(name) } },
    {
      timestamp: timestampMs(at + 1),
      user,
      action: { kind: "set-parent", parent: { kind: "branch", name: parseBranchName(parent) } },
    },
    { timestamp: timestampMs(at + 2), user, action: { kind: "set-base", base: parseCommitHash("0".repeat(40)) } },
    { timestamp: timestampMs(at + 3), user, action: { kind: "set-owner", owner: user } },
  ];
}

test("resolveChain links a stack ancestormost first, with each change's log", async () => {
  const logs: Record<string, readonly LogEntry[]> = {
    feature: created("feature", "main", 100),
    "feature-tests": created("feature-tests", "feature", 200),
    "feature-docs": created("feature-docs", "feature-tests", 300),
  };
  const changes = ["feature", "feature-tests", "feature-docs"].map(parseBranchName);
  expect(await resolveChain(logBackend(logs), changes)).toEqual(
    changes.map((name, index) => ({ id: changeId(index), entries: logs[name] })),
  );
});

test("resolveChain follows a reparent over the original parent", async () => {
  const user = userName("alice@example.com");
  const logs: Record<string, readonly LogEntry[]> = {
    base: created("base", "main", 100),
    moved: [
      ...created("moved", "elsewhere", 200),
      {
        timestamp: timestampMs(400),
        user,
        action: { kind: "set-parent", parent: { kind: "branch", name: parseBranchName("base") } },
      },
    ],
  };
  const changes = ["base", "moved"].map(parseBranchName);
  expect(await resolveChain(logBackend(logs), changes)).toEqual(
    changes.map((name, index) => ({ id: changeId(index), entries: logs[name] })),
  );
});

test("resolveChain rejects changes that do not stack", async () => {
  const backend = logBackend({
    trunk1: created("trunk1", "main", 100),
    trunk2: created("trunk2", "main", 200),
  });
  await expect(resolveChain(backend, ["trunk1", "trunk2"].map(parseBranchName))).rejects.toThrow(
    'not a stack: "trunk2"\'s parent is "main", not "trunk1"',
  );
});

test("resolveChain rejects a change that does not exist", async () => {
  const backend = logBackend({ real: created("real", "main", 100) });
  await expect(resolveChain(backend, ["real", "ghost"].map(parseBranchName))).rejects.toThrow(
    'change does not exist: "ghost"',
  );
});
