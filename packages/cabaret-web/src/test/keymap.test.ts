import { expect, test } from "vitest";
import { bindingsFor, KEYMAP } from "../keymap.js";
import { keyName } from "../keys.js";

test("step-outside answers on inner pages, not home", () => {
  expect(bindingsFor("home").some(({ command }) => command === "step-outside")).toBe(false);
  expect(bindingsFor("diff").some(({ command }) => command === "step-outside")).toBe(true);
});

const BROWSER_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  tab: "Tab",
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
};

test("every keymap key round-trips through keyName from the browser's spelling", () => {
  for (const { keys } of KEYMAP) {
    for (const key of keys) {
      const bare = key.replace(/^ctrl\+/, "");
      const stroke = {
        key: BROWSER_KEYS[bare] ?? bare,
        ctrlKey: key.startsWith("ctrl+"),
        altKey: false,
        metaKey: false,
      };
      expect(keyName(stroke), key).toBe(key);
    }
  }
});

test("keyName names special keys, printable keys, and ctrl chords", () => {
  const plain = { ctrlKey: false, altKey: false, metaKey: false };
  expect(keyName({ ...plain, key: "Enter" })).toBe("enter");
  expect(keyName({ ...plain, key: "Escape" })).toBe("esc");
  expect(keyName({ ...plain, key: "PageDown" })).toBe("pagedown");
  expect(keyName({ ...plain, key: "G" })).toBe("G");
  expect(keyName({ ...plain, key: "?" })).toBe("?");
  expect(keyName({ ...plain, key: "d", ctrlKey: true })).toBe("ctrl+d");
  expect(keyName({ ...plain, key: "PageDown", ctrlKey: true })).toBeUndefined();
  expect(keyName({ ...plain, key: "Shift" })).toBeUndefined();
  expect(keyName({ ...plain, key: "r", metaKey: true })).toBeUndefined();
  expect(keyName({ ...plain, key: "x", altKey: true })).toBeUndefined();
});
