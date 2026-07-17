import fc from "fast-check";
import { expect, test, vi } from "vitest";
import {
  type Backend,
  currentComments,
  type Forge,
  type ForgeComment,
  type ForgeSource,
  type LogEntry,
  parseBranchName,
  parseForgeLocator,
  planArchivedPull,
  planArchivedPush,
  planPull,
  planPush,
  planReviewerPull,
  planReviewerPush,
  planReviewingPull,
  planReviewingPush,
  pushChange,
  type Reviewing,
  type TimestampMs,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

const FORGE = parseForgeLocator("github.com/test-org/widgets");
const alice = userName("alice@example.com");
const bob = userName("bob@example.com");
const carol = userName("github:carol");

test("push resolves its identity before mutating the remote", async () => {
  const identityError = new Error("identity unavailable");
  const currentUser = vi.fn(async () => {
    throw identityError;
  });
  const push = vi.fn();
  const change = parseBranchName("feature");
  const parent = parseBranchName("main");

  await expect(
    pushChange({ currentUser, push } as unknown as Backend, testClock(), { locator: FORGE } as Forge, change, [
      { timestamp: timestampMs(1750000000000), user: alice, action: { kind: "set-parent", parent } },
    ]),
  ).rejects.toBe(identityError);
  expect({ identityReads: currentUser.mock.calls.length, pushes: push.mock.calls.length }).toEqual({
    identityReads: 1,
    pushes: 0,
  });
});

function comment(timestamp: number, user: UserName, text: string, source?: ForgeSource, edits?: string): LogEntry {
  return {
    timestamp: timestampMs(timestamp),
    user,
    ...(source === undefined ? {} : { source }),
    action: { kind: "comment", text, ...(edits === undefined ? {} : { edits }) },
  };
}

function forgeComment(id: string, author: UserName, body: string, updatedAt: number): ForgeComment {
  return { id, author, body, updatedAt: timestampMs(updatedAt) };
}

test("planPull imports foreign comments, timestamped and attributed by the forge", async () => {
  const entries = [comment(1748000000000, alice, "ship it")];
  const comments = [
    forgeComment("100", carol, "does this handle empty diffs?", 1750000000000),
    forgeComment("101", carol, "second thoughts:\n\nthe flag name reads oddly", 1750000000001),
  ];
  expect(await planPull(FORGE, entries, comments)).toEqual([
    comment(1750000000000, carol, "does this handle empty diffs?", { forge: FORGE, id: "100" }),
    comment(1750000000001, carol, "second thoughts:\n\nthe flag name reads oddly", { forge: FORGE, id: "101" }),
  ]);
});

test("planPull imports an in-place edit as a superseding entry", async () => {
  const entries = [comment(1750000000000, carol, "looks wrong", { forge: FORGE, id: "100" })];
  const comments = [forgeComment("100", carol, "looks wrong (never mind)", 1750000000009)];
  const plan = await planPull(FORGE, entries, comments);
  expect(plan).toEqual([comment(1750000000009, carol, "looks wrong (never mind)", { forge: FORGE, id: "100" })]);
  expect(await currentComments([...entries, ...plan])).toEqual([
    { timestamp: timestampMs(1750000000009), user: carol, text: "looks wrong (never mind)" },
  ]);
});

test("push then pull does not echo: reflected comments are recognized, plain and attributed", async () => {
  const entries = [comment(1748000000000, alice, "ship it"), comment(1748000000001, bob, "one nit")];
  const bodies = await planPush(entries, [], alice);
  expect(bodies).toEqual([
    expect.stringMatching(/^ship it\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\none nit\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
  ]);
  const reflected = bodies.map((body, index) => forgeComment(String(index), carol, body, 1750000000000 + index));
  expect(await planPull(FORGE, entries, reflected)).toEqual([]);
  expect(await planPush(entries, reflected, alice)).toEqual([]);
});

test("planPull imports a forge-side edit of a pushed comment as superseding its entry", async () => {
  const entries = [comment(1748000000000, alice, "ship it")];
  const [body] = await planPush(entries, [], alice);
  if (body === undefined) {
    throw new Error("nothing planned");
  }
  const hash = /<!-- cabaret:([0-9a-f]{64}) -->/.exec(body)?.[1];
  // An in-place edit rewrites the visible text; the marker rides along in the raw body.
  const edited = forgeComment("100", carol, `ship it (edited on the forge)\n\n<!-- cabaret:${hash} -->`, 1750000000009);
  const plan = await planPull(FORGE, entries, [edited]);
  expect(plan).toEqual([
    comment(1750000000009, carol, "ship it (edited on the forge)", { forge: FORGE, id: "100" }, hash),
  ]);
  // The versions collapse to one displayed comment, and the pull is settled.
  expect(await currentComments([...entries, ...plan])).toEqual([
    { timestamp: timestampMs(1750000000009), user: carol, text: "ship it (edited on the forge)" },
  ]);
  expect(await planPull(FORGE, [...entries, ...plan], [edited])).toEqual([]);
  // The original was pushed once; its entry must not be pushed again.
  expect(await planPush([...entries, ...plan], [edited], alice)).toEqual([]);
});

test("planPush skips imported comments and orders posts by timestamp", async () => {
  const entries = [
    comment(1748000000005, alice, "later"),
    comment(1750000000000, carol, "imported", { forge: FORGE, id: "100" }),
    comment(1748000000001, bob, "earlier"),
  ];
  expect(await planPush(entries, [], alice)).toEqual([
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\nearlier\n/),
    expect.stringMatching(/^later\n/),
  ]);
});

/** A `now` ticking one millisecond per read from a fixed epoch. */
function testClock(): () => TimestampMs {
  let clock = 1750000000000;
  return () => timestampMs(clock++);
}

function reviewerEntry(timestamp: number, kind: "add-reviewer" | "remove-reviewer", who: UserName, observed = false) {
  return {
    timestamp: timestampMs(timestamp),
    user: alice,
    ...(observed ? { source: { forge: FORGE } } : {}),
    action: { kind, reviewer: who },
  };
}

test("planReviewerPull mirrors what moved on the forge since last observed, and only that", () => {
  const dave = userName("dave@example.com");
  const entries = [
    // bob was observed on the forge and still is: nothing to mirror.
    reviewerEntry(1750000000000, "add-reviewer", bob, true),
    // carol was observed, then removed locally: intent, not the forge's move.
    reviewerEntry(1750000000001, "add-reviewer", carol, true),
    reviewerEntry(1750000000002, "remove-reviewer", carol),
  ];
  // dave appeared on the forge; carol is still there; bob left it.
  expect(planReviewerPull(testClock(), alice, FORGE, entries, [carol, dave])).toEqual([
    reviewerEntry(1750000000000, "remove-reviewer", bob, true),
    reviewerEntry(1750000000001, "add-reviewer", dave, true),
  ]);
  // The forge agreeing with every observation mirrors nothing, whatever
  // local intent is pending.
  expect(planReviewerPull(testClock(), alice, FORGE, entries, [bob, carol])).toEqual([]);
});

test("a forge-side add the mirror absorbs is not withdrawn by the push", () => {
  const mirrored = planReviewerPull(testClock(), alice, FORGE, [], [bob]);
  expect(mirrored).toEqual([reviewerEntry(1750000000000, "add-reviewer", bob, true)]);
  expect(planReviewerPush(testClock(), alice, FORGE, mirrored, [bob])).toEqual({
    add: [],
    remove: [],
    observations: [],
  });
});

test("planReviewerPush pushes exactly local intent once the mirror has been absorbed", () => {
  const entries = [
    reviewerEntry(1750000000000, "add-reviewer", bob, true),
    reviewerEntry(1750000000001, "remove-reviewer", bob),
    reviewerEntry(1750000000002, "add-reviewer", carol),
  ];
  const forgeReviewers = [bob];
  const mirrored = planReviewerPull(testClock(), alice, FORGE, entries, forgeReviewers);
  expect(mirrored).toEqual([]);
  const plan = planReviewerPush(testClock(), alice, FORGE, [...entries, ...mirrored], forgeReviewers);
  expect(plan).toEqual({
    add: [carol],
    remove: [bob],
    observations: [
      reviewerEntry(1750000000000, "add-reviewer", carol, true),
      reviewerEntry(1750000000001, "remove-reviewer", bob, true),
    ],
  });
  // The observations settle the push: planning again moves nothing, and the
  // next pull mirrors nothing back.
  const settled = [...entries, ...mirrored, ...plan.observations];
  expect(planReviewerPush(testClock(), alice, FORGE, settled, [carol])).toEqual({
    add: [],
    remove: [],
    observations: [],
  });
  expect(planReviewerPull(testClock(), alice, FORGE, settled, [carol])).toEqual([]);
});

function reviewingEntry(timestamp: number, reviewing: Reviewing, observed = false) {
  return {
    timestamp: timestampMs(timestamp),
    user: alice,
    ...(observed ? { source: { forge: FORGE } } : {}),
    action: { kind: "set-reviewing" as const, reviewing },
  };
}

test("planReviewingPull mirrors a forge draft toggle, and only a toggle since last observed", () => {
  // Observed ready; the forge was converted to a draft since.
  const observed = [reviewingEntry(1750000000000, "everyone", true)];
  expect(planReviewingPull(testClock(), alice, FORGE, observed, true)).toEqual([
    reviewingEntry(1750000000000, "none", true),
  ]);
  // The forge still agreeing with the observation mirrors nothing, whatever
  // local narrowing is pending.
  const narrowed = [...observed, reviewingEntry(1750000000001, "owner")];
  expect(planReviewingPull(testClock(), alice, FORGE, narrowed, false)).toEqual([]);
  // A draft marked ready mirrors in as everyone: the forge-faithful reading.
  const draft = [reviewingEntry(1750000000000, "none", true)];
  expect(planReviewingPull(testClock(), alice, FORGE, draft, false)).toEqual([
    reviewingEntry(1750000000000, "everyone", true),
  ]);
  // A forge never observed mirrors nothing; a push settles the sides.
  expect(planReviewingPull(testClock(), alice, FORGE, [], true)).toEqual([]);
});

test("planReviewingPush pushes the local draft boundary and records the observation", () => {
  // Local narrowed to none; the forge still shows ready.
  const entries = [reviewingEntry(1750000000000, "everyone", true), reviewingEntry(1750000000001, "none")];
  const plan = planReviewingPush(testClock(), alice, FORGE, entries, false);
  expect(plan).toEqual({ draft: true, observations: [reviewingEntry(1750000000000, "none", true)] });
  // The observation settles the push: planning again moves nothing, and the
  // next pull mirrors nothing back.
  const settled = [...entries, ...plan.observations];
  expect(planReviewingPush(testClock(), alice, FORGE, settled, true)).toEqual({ observations: [] });
  expect(planReviewingPull(testClock(), alice, FORGE, settled, true)).toEqual([]);
  // Widening within ready never touches the forge: the boundary agrees.
  const widened = [reviewingEntry(1750000000000, "owner")];
  expect(planReviewingPush(testClock(), alice, FORGE, widened, false)).toEqual({ observations: [] });
});

function archivedEntry(timestamp: number, archived: boolean, observed = false) {
  return {
    timestamp: timestampMs(timestamp),
    user: alice,
    ...(observed ? { source: { forge: FORGE } } : {}),
    action: { kind: "set-archived" as const, archived },
  };
}

test("planArchivedPull mirrors a forge close or reopen, and only one since last observed", () => {
  // A forge change starts open, so a log never observed reads as having
  // observed open: a close mirrors in without a baseline entry.
  expect(planArchivedPull(testClock(), alice, FORGE, [], true)).toEqual([archivedEntry(1750000000000, true, true)]);
  expect(planArchivedPull(testClock(), alice, FORGE, [], false)).toEqual([]);
  // The forge still agreeing with the observation mirrors nothing, whatever
  // local intent is pending its push.
  const closed = [archivedEntry(1750000000000, true, true)];
  expect(planArchivedPull(testClock(), alice, FORGE, closed, true)).toEqual([]);
  const revived = [...closed, archivedEntry(1750000000001, false)];
  expect(planArchivedPull(testClock(), alice, FORGE, revived, true)).toEqual([]);
  // A reopen since the closed observation mirrors back in.
  expect(planArchivedPull(testClock(), alice, FORGE, closed, false)).toEqual([
    archivedEntry(1750000000000, false, true),
  ]);
});

test("planArchivedPush pushes the local archived state and records the observation", () => {
  // Locally archived; the forge still shows open.
  const entries = [archivedEntry(1750000000000, true)];
  const plan = planArchivedPush(testClock(), alice, FORGE, entries, false);
  expect(plan).toEqual({ state: "closed", observations: [archivedEntry(1750000000000, true, true)] });
  // The observation settles the push: planning again moves nothing, and the
  // next pull mirrors nothing back.
  const settled = [...entries, ...plan.observations];
  expect(planArchivedPush(testClock(), alice, FORGE, settled, true)).toEqual({ observations: [] });
  expect(planArchivedPull(testClock(), alice, FORGE, settled, true)).toEqual([]);
  // A local unarchive reopens a closed forge change.
  const reviving = [...settled, archivedEntry(1750000000002, false)];
  expect(planArchivedPush(testClock(), alice, FORGE, reviving, true)).toEqual({
    state: "open",
    observations: [archivedEntry(1750000000000, false, true)],
  });
  // Sides agreeing move nothing.
  expect(planArchivedPush(testClock(), alice, FORGE, [], false)).toEqual({ observations: [] });
});

const forgeUsers = () =>
  fc
    .string({ minLength: 1, unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz") })
    .map((login) => userName(`github:${login}`));

const foreignComments = () =>
  fc
    .uniqueArray(fc.tuple(fc.nat(), forgeUsers(), fc.string({ minLength: 1, unit: "grapheme" })), {
      selector: ([id]) => id,
    })
    .map((tuples) =>
      tuples.map(([id, author, body], index) => forgeComment(String(id), author, body, 1750000000000 + index)),
    );

test("pulling what a pull imported is a no-op, and re-planning is byte-identical", async () => {
  await fc.assert(
    fc.asyncProperty(foreignComments(), async (comments) => {
      const plan = await planPull(FORGE, [], comments);
      expect(await planPull(FORGE, [], comments)).toEqual(plan);
      expect(await planPull(FORGE, plan, comments)).toEqual([]);
    }),
  );
});

const localComments = () =>
  fc
    .uniqueArray(
      fc.tuple(fc.nat(), fc.constantFrom(alice, bob), fc.string({ minLength: 1, unit: fc.constantFrom(..."abc \n*") })),
      { selector: ([timestamp]) => timestamp },
    )
    .map((tuples) => tuples.map(([timestamp, user, text]) => comment(timestamp, user, text)));

test("pushing what a push posted is a no-op, and nothing echoes back", async () => {
  await fc.assert(
    fc.asyncProperty(localComments(), async (entries) => {
      const bodies = await planPush(entries, [], alice);
      expect(bodies.length).toBe(entries.length);
      const posted = bodies.map((body, index) => forgeComment(String(index), carol, body, 1750000000000 + index));
      expect(await planPush(entries, posted, alice)).toEqual([]);
      expect(await planPull(FORGE, entries, posted)).toEqual([]);
    }),
  );
});
