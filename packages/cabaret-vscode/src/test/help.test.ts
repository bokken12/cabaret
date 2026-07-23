import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type Manifest, pageHelp, pageHints } from "../help.js";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;

test("home page keybindings", () => {
  expect(pageHelp(manifest, "home").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "r  Review",
      "d  Diff",
      "@  Act as User",
      "! r b  Rebase",
      "! l  Land",
      "! r p  Reparent",
      "! o  Set Owner",
      "! v  Widen Reviewing",
      "! d  Disable Reviewing",
      "! a  Toggle Archived",
      "! g  Go to Workspace",
      "! w a  Add Workspace",
      "! w d  Remove Workspace",
      "! w r  Reclaim Workspaces",
      "! c  Create Child",
      "! p  Create Parent",
      "F  Fetch Remote Activity",
      "S  Sync Change",
    ]
  `);
});

test("show page keybindings", () => {
  expect(pageHelp(manifest, "show").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "esc  Step Outside",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "r  Review",
      "d  Diff",
      "@  Act as User",
      "^  Step Up",
      "$  Step Down",
      "! r b  Rebase",
      "! l  Land",
      "! r p  Reparent",
      "! o  Set Owner",
      "! v  Widen Reviewing",
      "! d  Disable Reviewing",
      "! a  Toggle Archived",
      "! g  Go to Workspace",
      "! w a  Add Workspace",
      "! w d  Remove Workspace",
      "! c  Create Child",
      "! p  Create Parent",
      "F  Fetch Remote Activity",
      "S  Sync Change",
    ]
  `);
});

test("review page keybindings", () => {
  expect(pageHelp(manifest, "review").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "esc  Step Outside",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "d  Diff",
      "@  Act as User",
      "! m  Mark Reviewed",
      "^  Step Up",
      "$  Step Down",
      "! l  Land",
      "! c  Create Child",
      "! p  Create Parent",
      "F  Fetch Remote Activity",
      "S  Sync Change",
    ]
  `);
});

test("review-file page keybindings", () => {
  expect(pageHelp(manifest, "review").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "esc  Step Outside",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "d  Diff",
      "@  Act as User",
      "! m  Mark Reviewed",
      "^  Step Up",
      "$  Step Down",
      "! l  Land",
      "! c  Create Child",
      "! p  Create Parent",
      "F  Fetch Remote Activity",
      "S  Sync Change",
    ]
  `);
});

test("help carries the command, so picking an entry can run it", () => {
  expect(pageHelp(manifest, "review").map(({ keys, command }) => `${keys}  ${command}`)).toMatchInlineSnapshot(`
    [
      "enter  cabaret.openTarget",
      "esc  cabaret.stepOutside",
      "tab  editor.toggleFold",
      "q  workbench.action.closeActiveEditor",
      "R  cabaret.refresh",
      "?  cabaret.help",
      "d  cabaret.diff",
      "@  cabaret.actAs",
      "! m  cabaret.markReviewed",
      "^  cabaret.stepUp",
      "$  cabaret.stepDown",
      "! l  cabaret.land",
      "! c  cabaret.createChild",
      "! p  cabaret.createParent",
      "F  cabaret.fetch",
      "S  cabaret.sync",
    ]
  `);
});

const bind = (key: string, when: string): Manifest => ({
  contributes: {
    commands: [{ command: "cabaret.example", title: "Cabaret: Example" }],
    keybindings: [{ command: "cabaret.example", key, when }],
  },
});

const GUARDED = (scope: string) =>
  `editorTextFocus && ${scope} && (!vim.active || vim.mode == 'Normal' || vim.mode == 'Visual' || vim.mode == 'VisualLine' || vim.mode == 'VisualBlock')`;

test("a binding outside the when grammar throws rather than going missing", () => {
  expect(() => pageHelp(bind("x", "resourceScheme == cabaret"), "home")).toThrowError(/standard guards/);
  expect(() => pageHelp(bind("x", GUARDED("cabaret.page =~ /show|diff/")), "home")).toThrowError(
    /unrecognized keybinding scope/,
  );
  expect(() =>
    pageHelp(bind("x", GUARDED("resourceScheme == cabaret && cabaret.page != 'diff'")), "home"),
  ).toThrowError(/unrecognized keybinding scope/);
  expect(() => pageHelp(bind("x", GUARDED("cabaret.page == 'shw'")), "home")).toThrowError(/unknown page kind/);
});

test("a shifted key with no known display form throws", () => {
  expect(() => pageHelp(bind("shift+-", GUARDED("resourceScheme == cabaret")), "home")).toThrowError(/no shifted form/);
});

test("a bound command with no title throws", () => {
  const manifest: Manifest = {
    contributes: {
      commands: [],
      keybindings: [{ command: "cabaret.mystery", key: "m", when: GUARDED("resourceScheme == cabaret") }],
    },
  };
  expect(() => pageHelp(manifest, "home")).toThrowError(/no title known/);
});

test("page hints carry the keys behind each next step a binding performs there", () => {
  const home = pageHints(manifest, "home");
  expect(home.help).toBe("?");
  expect([...home.steps]).toMatchInlineSnapshot(`
    [
      [
        "sync",
        "S",
      ],
      [
        "rebase",
        "! r b",
      ],
      [
        "reparent",
        "! r p",
      ],
      [
        "review",
        "r",
      ],
      [
        "widen reviewing",
        "! v",
      ],
      [
        "land",
        "! l",
      ],
    ]
  `);
  // The review binding does not answer on the reviews page, so the review
  // step goes bare there while the page-wide actions keep their keys.
  expect([...pageHints(manifest, "reviews").steps]).toMatchInlineSnapshot(`
    [
      [
        "sync",
        "S",
      ],
      [
        "rebase",
        "! r b",
      ],
      [
        "reparent",
        "! r p",
      ],
      [
        "widen reviewing",
        "! v",
      ],
      [
        "land",
        "! l",
      ],
    ]
  `);
});
