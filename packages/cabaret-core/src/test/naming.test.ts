import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeId,
  type ChangeName,
  type LogEntry,
  lookupChange,
  parseBranchName,
  parseChangeId,
  resolveChange,
  timestampMs,
  userName,
} from "../index.js";

/** A log whose every entry is one tick apart, starting at `at`. */
function log(name: string, at: number, ...actions: readonly LogEntry["action"][]): LogEntry[] {
  const user = userName("alice@example.com");
  return [
    { timestamp: timestampMs(at), user, action: { kind: "set-name", name: parseBranchName(name) } },
    ...actions.map((action, index) => ({ timestamp: timestampMs(at + 1 + index), user, action })),
  ];
}

function changeId(index: number): ChangeId {
  return parseChangeId((index + 1).toString(16).repeat(32).slice(0, 32));
}

/**
 * A backend of mutable logs with the name index's dependencies: `logStates`
 * tokens change with each log's length, the cache is an in-memory cell, and
 * every `readLog` is counted so tests can pin what a resolution read.
 */
function indexBackend(logs: Record<string, LogEntry[]>) {
  const names = Object.keys(logs);
  const cache = new Map<string, string>();
  const reads: ChangeId[] = [];
  const idOf = new Map(names.map((name, index) => [name, changeId(index)] as const));
  const entriesOf = (id: ChangeId): LogEntry[] => {
    const name = names.find((held) => idOf.get(held) === id);
    return (name === undefined ? undefined : logs[name]) ?? [];
  };
  const stub: Pick<Backend, "logStates" | "readCache" | "writeCache" | "readLog"> = {
    async logStates() {
      const live = names.filter((held) => logs[held] !== undefined);
      return new Map(live.map((held) => [idOf.get(held) as ChangeId, String(logs[held]?.length)]));
    },
    async readCache(key) {
      return cache.get(key);
    },
    async writeCache(key, content) {
      cache.set(key, content);
    },
    async readLog(change) {
      reads.push(change);
      return entriesOf(change);
    },
  };
  return { backend: stub as Backend, reads, cache, idOf: (name: string) => idOf.get(name) as ChangeId };
}

const name = (raw: string): ChangeName => parseBranchName(raw);

test("a warm resolution reads only the winner's log", async () => {
  const { backend, reads } = indexBackend({
    gadget: log("gadget", 100),
    widget: log("widget", 200),
    gizmo: log("gizmo", 300),
  });
  const cold = await resolveChange(backend, name("widget"));
  expect(cold.entries).toEqual(log("widget", 200));
  // The cold pass folded every log; from here each resolution reads one.
  reads.length = 0;
  const warm = await resolveChange(backend, name("gizmo"));
  expect(warm.entries).toEqual(log("gizmo", 300));
  expect(reads).toEqual([warm.id]);
});

test("a moved log re-folds, and only it", async () => {
  const logs = {
    gadget: log("gadget", 100),
    widget: log("widget", 200),
  };
  const { backend, reads, idOf } = indexBackend(logs);
  await resolveChange(backend, name("gadget"));
  logs.widget.push({
    timestamp: timestampMs(900),
    user: userName("alice@example.com"),
    action: { kind: "set-archived", archived: true },
  });
  reads.length = 0;
  const found = await resolveChange(backend, name("gadget"));
  // The drifted widget re-folded; gadget's held facts stood, and only the
  // winner's log was read beyond it.
  expect(reads.sort()).toEqual([idOf("gadget"), idOf("widget")].sort());
  expect(found.id).toBe(idOf("gadget"));
});

test("a corrupt index rebuilds instead of failing", async () => {
  const { backend, cache } = indexBackend({ gadget: log("gadget", 100) });
  await resolveChange(backend, name("gadget"));
  cache.set("names.json", "not json");
  const found = await lookupChange(backend, name("gadget"));
  expect(found?.entries).toEqual(log("gadget", 100));
});

test("a deleted log leaves the index, and its name stops resolving", async () => {
  const logs: Record<string, LogEntry[]> = {
    gadget: log("gadget", 100),
    pruned: log("pruned", 200),
  };
  const { backend } = indexBackend(logs);
  await resolveChange(backend, name("pruned"));
  delete logs.pruned;
  expect(await lookupChange(backend, name("pruned"))).toBeUndefined();
  expect(await lookupChange(backend, name("gadget"))).toBeDefined();
});

test("arbitration through the index: live beats archived, archived resolve by recency", async () => {
  const { backend, idOf } = indexBackend({
    old: log("shared", 100, { kind: "set-archived", archived: true }),
    newer: log("shared", 200, { kind: "set-archived", archived: true }),
    live: log("shared", 50),
  });
  expect((await lookupChange(backend, name("shared")))?.id).toBe(idOf("live"));
  const { backend: archivedOnly, idOf: archivedIds } = indexBackend({
    old: log("shared", 100, { kind: "set-archived", archived: true }),
    newer: log("shared", 200, { kind: "set-archived", archived: true }),
  });
  expect((await lookupChange(archivedOnly, name("shared")))?.id).toBe(archivedIds("newer"));
});

test("two live claims fail with both ids, and an id prefix then resolves", async () => {
  const { backend, idOf } = indexBackend({
    first: log("shared", 100),
    second: log("shared", 200),
  });
  await expect(lookupChange(backend, name("shared"))).rejects.toThrow(
    `multiple live changes are named "shared": ${[idOf("first"), idOf("second")].sort().join(", ")}; use an id`,
  );
  const byPrefix = await resolveChange(backend, name(idOf("second").slice(0, 8)));
  expect(byPrefix.id).toBe(idOf("second"));
});

test("an unclaimed name fails with the create remedy", async () => {
  const { backend } = indexBackend({ gadget: log("gadget", 100) });
  await expect(resolveChange(backend, name("ghost"))).rejects.toThrow(
    'change does not exist: "ghost"; run `cab create`, or `cab fetch` to import open forge changes',
  );
});
