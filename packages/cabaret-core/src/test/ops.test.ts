import { expect, test } from "vitest";
import {
  type Backend,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  resolveChain,
  timestampMs,
  userName,
} from "../index.js";

/** A backend of just the given logs; only the member `resolveChain` touches exists. */
function logBackend(logs: Record<string, readonly LogEntry[]>): Backend {
  const stub: Pick<Backend, "readLog"> = {
    async readLog(change) {
      return logs[change] ?? [];
    },
  };
  return stub as Backend;
}

/** The log entries `create` writes: a parent, a base, and an owner. */
function created(parent: string, at: number): readonly LogEntry[] {
  const user = userName("alice@example.com");
  return [
    { timestamp: timestampMs(at), user, action: { kind: "set-parent", parent: parseBranchName(parent) } },
    { timestamp: timestampMs(at + 1), user, action: { kind: "set-base", base: parseCommitHash("0".repeat(40)) } },
    { timestamp: timestampMs(at + 2), user, action: { kind: "set-owner", owner: user } },
  ];
}

test("resolveChain links a stack ancestormost first, with each change's log", async () => {
  const logs: Record<string, readonly LogEntry[]> = {
    feature: created("main", 100),
    "feature-tests": created("feature", 200),
    "feature-docs": created("feature-tests", 300),
  };
  const changes = ["feature", "feature-tests", "feature-docs"].map(parseBranchName);
  expect(await resolveChain(logBackend(logs), changes)).toEqual(
    changes.map((change) => ({ change, entries: logs[change] })),
  );
});

test("resolveChain follows a reparent over the original parent", async () => {
  const user = userName("alice@example.com");
  const logs: Record<string, readonly LogEntry[]> = {
    base: created("main", 100),
    moved: [
      ...created("elsewhere", 200),
      { timestamp: timestampMs(400), user, action: { kind: "set-parent", parent: parseBranchName("base") } },
    ],
  };
  const changes = ["base", "moved"].map(parseBranchName);
  expect(await resolveChain(logBackend(logs), changes)).toEqual(
    changes.map((change) => ({ change, entries: logs[change] })),
  );
});

test("resolveChain rejects changes that do not stack", async () => {
  const backend = logBackend({
    trunk1: created("main", 100),
    trunk2: created("main", 200),
  });
  await expect(resolveChain(backend, ["trunk1", "trunk2"].map(parseBranchName))).rejects.toThrow(
    'not a stack: "trunk2"\'s parent is "main", not "trunk1"',
  );
});

test("resolveChain rejects a change that does not exist", async () => {
  const backend = logBackend({ real: created("main", 100) });
  await expect(resolveChain(backend, ["real", "ghost"].map(parseBranchName))).rejects.toThrow(
    'change does not exist: "ghost"',
  );
});
