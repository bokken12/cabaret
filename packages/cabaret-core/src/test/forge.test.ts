import fc from "fast-check";
import { expect, test } from "vitest";
import {
  type CommentSource,
  currentComments,
  type ForgeComment,
  type LogEntry,
  parseForgeLocator,
  planPull,
  planPush,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

const FORGE = parseForgeLocator("github.com/test-org/widgets");
const alice = userName("alice@example.com");
const bob = userName("bob@example.com");
const carol = userName("carol@users.noreply.github.com");

function comment(timestamp: number, user: UserName, text: string, source?: CommentSource): LogEntry {
  return {
    timestamp: timestampMs(timestamp),
    user,
    action: { kind: "comment", text, ...(source === undefined ? {} : { source }) },
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
    comment(1750000000009, carol, "ship it (edited on the forge)", { forge: FORGE, id: "100", edits: hash }),
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

const forgeUsers = () =>
  fc
    .string({ minLength: 1, unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz") })
    .map((login) => userName(`${login}@users.noreply.github.com`));

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
