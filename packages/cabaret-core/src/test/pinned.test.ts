import { expect, test } from "vitest";
import {
  type Backend,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  type RefSnapshot,
  type Revision,
  timestampMs,
  userName,
} from "../backend.js";
import { pinBackend } from "../pinned.js";

function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

const feature = parseBranchName("feature");
const gone = parseBranchName("gone");
const main = parseBranchName("main");

const featureLog: readonly LogEntry[] = [
  {
    timestamp: timestampMs(1748000000000),
    user: userName("alice@example.com"),
    action: { kind: "set-parent", parent: main },
  },
];

/** Only the members the tests reach exist; an unanticipated call fails loudly. */
function stubBackend(): Backend {
  const stub: Pick<Backend, "readLogAt" | "hasRevision" | "readFile"> = {
    async readLogAt(tip) {
      expect(tip).toBe(fake("c"));
      return featureLog;
    },
    async hasRevision(revision) {
      return revision !== fake("d");
    },
    async readFile(commit, file) {
      return `${file} at ${commit[0]}`;
    },
  };
  return stub as Backend;
}

function snapshot(): RefSnapshot {
  return {
    heads: new Map([[feature, fake("a")]]),
    origins: new Map([[feature, fake("b")]]),
    logs: new Map([[feature, fake("c")]]),
  };
}

test("serves ref reads from the snapshot and records them, absence included", async () => {
  const { backend, reads } = pinBackend(stubBackend(), snapshot());
  expect(await backend.tip(feature)).toBe(fake("a"));
  expect(await backend.tip(gone)).toBeUndefined();
  expect(await backend.originTip(feature)).toBe(fake("b"));
  expect(await backend.readLog(feature)).toEqual(featureLog);
  expect(await backend.readLog(gone)).toEqual([]);
  expect(reads).toEqual({
    heads: new Map([
      [feature, fake("a")],
      [gone, undefined],
    ]),
    origins: new Map([[feature, fake("b")]]),
    logs: new Map([
      [feature, fake("c")],
      [gone, undefined],
    ]),
    absent: new Set(),
  });
});

test("records the revisions probed and found missing, and only those", async () => {
  const { backend, reads } = pinBackend(stubBackend(), snapshot());
  expect(await backend.hasRevision(fake("a"))).toBe(true);
  expect(await backend.hasRevision(fake("d"))).toBe(false);
  expect(reads.absent).toEqual(new Set([fake("d")]));
});

test("passes pure object queries through", async () => {
  const { backend } = pinBackend(stubBackend(), snapshot());
  expect(await backend.readFile(fake("a"), parseFilePath("x.ts"))).toBe("x.ts at a");
});

test("refuses reads and writes the snapshot does not pin", async () => {
  const { backend } = pinBackend(stubBackend(), snapshot());
  await expect(async () => backend.currentUser()).rejects.toThrow("currentUser is not available on a pinned backend");
  await expect(async () => backend.appendLog(feature, [])).rejects.toThrow(
    "appendLog is not available on a pinned backend",
  );
});
