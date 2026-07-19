import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type Manifest, pageHelp } from "../help.js";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;

test("home page keybindings", () => {
  expect(pageHelp(manifest, "home").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "@  Act as User",
      "! r b  Rebase",
      "! l a  Land",
      "! r n  Rename",
      "! r p  Reparent",
      "! o  Set Owner",
      "! v  Widen Reviewing",
      "! d  Disable Reviewing",
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

test("show page keybindings", () => {
  expect(pageHelp(manifest, "show").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "r  Review",
      "d  Review Diffs",
      "@  Act as User",
      "^  Show Parent",
      "$  Show Child",
      "! r b  Rebase",
      "! l a  Land",
      "! r n  Rename",
      "! r p  Reparent",
      "! o  Set Owner",
      "! v  Widen Reviewing",
      "! d  Disable Reviewing",
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
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "d  Review Diffs",
      "@  Act as User",
      "! m  Mark Reviewed",
      "! r b  Rebase",
      "! l a  Land",
      "! r n  Rename",
      "! r p  Reparent",
      "! o  Set Owner",
      "! v  Widen Reviewing",
      "! d  Disable Reviewing",
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

test("diff page keybindings", () => {
  expect(pageHelp(manifest, "diff").map(({ keys, label }) => `${keys}  ${label}`)).toMatchInlineSnapshot(`
    [
      "enter  Open Target at Cursor",
      "tab  Toggle Fold",
      "q  Close Page",
      "R  Refresh",
      "?  Keybindings",
      "@  Act as User",
      "! m  Mark Reviewed",
      "! l a  Land",
      "! c  Create Child",
      "! p  Create Parent",
      "F  Fetch Remote Activity",
      "S  Sync Change",
    ]
  `);
});

test("help carries the command, so picking an entry can run it", () => {
  expect(pageHelp(manifest, "diff").map(({ keys, command }) => `${keys}  ${command}`)).toMatchInlineSnapshot(`
    [
      "enter  cabaret.openTarget",
      "tab  editor.toggleFold",
      "q  workbench.action.closeActiveEditor",
      "R  cabaret.refresh",
      "?  cabaret.help",
      "@  cabaret.actAs",
      "! m  cabaret.markReviewed",
      "! l a  cabaret.land",
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
