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
  publishForgeChange,
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

test("publish resolves its identity before mutating the forge", async () => {
  const identityError = new Error("identity unavailable");
  const currentUser = vi.fn(async () => {
    throw identityError;
  });
  const createChange = vi.fn();
  const change = parseBranchName("feature");
  const parent = parseBranchName("main");

  await expect(
    publishForgeChange(
      { currentUser } as unknown as Backend,
      testClock(),
      { locator: FORGE, createChange } as unknown as Forge,
      change,
      [{ timestamp: timestampMs(1750000000000), user: alice, action: { kind: "set-parent", parent } }],
      undefined,
    ),
  ).rejects.toBe(identityError);
  expect({ identityReads: currentUser.mock.calls.length, creations: createChange.mock.calls.length }).toEqual({
    identityReads: 1,
    creations: 0,
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
    {
      key: `${FORGE}#100`,
      timestamp: timestampMs(1750000000009),
      user: carol,
      text: "looks wrong (never mind)",
      edited: true,
    },
  ]);
});

test("push then pull does not echo: reflected comments are recognized, plain and attributed", async () => {
  const entries = [comment(1748000000000, alice, "ship it"), comment(1748000000001, bob, "one nit")];
  const push = await planPush(FORGE, entries, [], alice);
  expect(push).toEqual({
    posts: [
      expect.stringMatching(/^ship it\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
      expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\none nit\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
    ],
    updates: [],
  });
  const reflected = push.posts.map((body, index) => forgeComment(String(index), carol, body, 1750000000000 + index));
  expect(await planPull(FORGE, entries, reflected)).toEqual([]);
  expect(await planPush(FORGE, entries, reflected, alice)).toEqual({ posts: [], updates: [] });
});

test("planPull imports a forge-side edit of a pushed comment as superseding its entry", async () => {
  const entries = [comment(1748000000000, alice, "ship it")];
  const [body] = (await planPush(FORGE, entries, [], alice)).posts;
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
    {
      key: hash,
      timestamp: timestampMs(1750000000009),
      user: carol,
      text: "ship it (edited on the forge)",
      edited: true,
    },
  ]);
  expect(await planPull(FORGE, [...entries, ...plan], [edited])).toEqual([]);
  // The original was pushed once; its entry must not be pushed again.
  expect(await planPush(FORGE, [...entries, ...plan], [edited], alice)).toEqual({ posts: [], updates: [] });
});

test("planPush skips imported comments and orders posts by timestamp", async () => {
  const entries = [
    comment(1748000000005, alice, "later"),
    comment(1750000000000, carol, "imported", { forge: FORGE, id: "100" }),
    comment(1748000000001, bob, "earlier"),
  ];
  expect((await planPush(FORGE, entries, [], alice)).posts).toEqual([
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\nearlier\n/),
    expect.stringMatching(/^later\n/),
  ]);
});

test("a local edit of a pushed comment updates the forge comment in place, marker preserved", async () => {
  const original = comment(1748000000000, alice, "ship it");
  const [body] = (await planPush(FORGE, [original], [], alice)).posts;
  if (body === undefined) {
    throw new Error("nothing planned");
  }
  const key = /<!-- cabaret:([0-9a-f]{64}) -->/.exec(body)?.[1];
  if (key === undefined) {
    throw new Error("no marker");
  }
  const posted = forgeComment("100", alice, body, 1748000000001);
  const entries = [original, comment(1750000000000, alice, "ship it, once the flag lands", undefined, key)];
  // The edit rewrites the posted comment rather than posting anew.
  expect(await planPush(FORGE, entries, [posted], alice)).toEqual({
    posts: [],
    updates: [{ id: "100", body: `ship it, once the flag lands\n\n<!-- cabaret:${key} -->` }],
  });
  // The pull does not mistake the stale forge body for a forge-side edit.
  expect(await planPull(FORGE, entries, [posted])).toEqual([]);
  // Once the update lands, both directions are settled.
  const updated = forgeComment("100", alice, `ship it, once the flag lands\n\n<!-- cabaret:${key} -->`, 1750000000001);
  expect(await planPush(FORGE, entries, [updated], alice)).toEqual({ posts: [], updates: [] });
  expect(await planPull(FORGE, entries, [updated])).toEqual([]);
  expect(await currentComments(entries)).toEqual([
    { key, timestamp: timestampMs(1750000000000), user: alice, text: "ship it, once the flag lands", edited: true },
  ]);
});

test("a local edit of a forge-native comment updates it by its id, unmarked", async () => {
  const imported = comment(1748000000000, carol, "does this handle empty diffs?", { forge: FORGE, id: "100" });
  const entries = [
    imported,
    comment(1750000000000, alice, "does this handle empty diffs? (answered below)", undefined, `${FORGE}#100`),
  ];
  const posted = forgeComment("100", carol, "does this handle empty diffs?", 1748000000000);
  expect(await planPush(FORGE, entries, [posted], alice)).toEqual({
    posts: [],
    updates: [{ id: "100", body: "**alice@example.com:**\n\ndoes this handle empty diffs? (answered below)" }],
  });
  expect(await planPull(FORGE, entries, [posted])).toEqual([]);
  // Gone from the forge entirely, the comment is nobody's to rewrite — and
  // never reposted, which would resurrect it under a new identity.
  expect(await planPush(FORGE, entries, [], alice)).toEqual({ posts: [], updates: [] });
});

test("concurrent forge and local edits settle by timestamp once the pull is absorbed", async () => {
  const original = comment(1748000000000, alice, "ship it");
  const [body] = (await planPush(FORGE, [original], [], alice)).posts;
  if (body === undefined) {
    throw new Error("nothing planned");
  }
  const key = /<!-- cabaret:([0-9a-f]{64}) -->/.exec(body)?.[1];
  if (key === undefined) {
    throw new Error("no marker");
  }
  const edited = forgeComment("100", alice, `ship it — sorry, hold off\n\n<!-- cabaret:${key} -->`, 1750000000005);
  // The forge's edit is content the log has never held, so it imports
  // whichever side wrote last.
  const localFirst = [original, comment(1750000000000, alice, "ship it, once the flag lands", undefined, key)];
  const plan = await planPull(FORGE, localFirst, [edited]);
  expect(plan).toEqual([comment(1750000000005, alice, "ship it — sorry, hold off", { forge: FORGE, id: "100" }, key)]);
  // Forge edit written later: it wins the group, and the push leaves it be.
  expect(await currentComments([...localFirst, ...plan])).toEqual([
    { key, timestamp: timestampMs(1750000000005), user: alice, text: "ship it — sorry, hold off", edited: true },
  ]);
  expect(await planPush(FORGE, [...localFirst, ...plan], [edited], alice)).toEqual({ posts: [], updates: [] });
  // Local edit written later: it wins the group, and the push rewrites the forge.
  const localLast = [original, comment(1750000000009, alice, "ship it, once the flag lands", undefined, key)];
  expect(
    await planPush(FORGE, [...localLast, ...(await planPull(FORGE, localLast, [edited]))], [edited], alice),
  ).toEqual({
    posts: [],
    updates: [{ id: "100", body: `ship it, once the flag lands\n\n<!-- cabaret:${key} -->` }],
  });
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
      const { posts, updates } = await planPush(FORGE, entries, [], alice);
      expect({ posts: posts.length, updates }).toEqual({ posts: entries.length, updates: [] });
      const posted = posts.map((body, index) => forgeComment(String(index), carol, body, 1750000000000 + index));
      expect(await planPush(FORGE, entries, posted, alice)).toEqual({ posts: [], updates: [] });
      expect(await planPull(FORGE, entries, posted)).toEqual([]);
    }),
  );
});
