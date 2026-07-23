import { expect, test } from "vitest";
import { keyName, mouseEvent } from "../keys.js";

test("keyName names keys as the keymap spells them", () => {
  expect(keyName({ name: "return", sequence: "\r" })).toBe("enter");
  expect(keyName({ name: "tab", sequence: "\t" })).toBe("tab");
  expect(keyName({ name: "escape", sequence: "\x1b", meta: true })).toBe("esc");
  expect(keyName({ name: "down", sequence: "\x1b[B" })).toBe("down");
  expect(keyName({ name: "q", sequence: "q" })).toBe("q");
  expect(keyName({ name: "r", sequence: "R", shift: true })).toBe("R");
  expect(keyName({ sequence: "!" })).toBe("!");
  expect(keyName({ sequence: "?" })).toBe("?");
  expect(keyName({ name: "d", sequence: "\x04", ctrl: true })).toBe("ctrl+d");
  expect(keyName({ name: "space", sequence: " " })).toBe("space");
  expect(keyName({ sequence: "\x7f", name: "backspace" })).toBe("backspace");
});

test("keyName declines what the keymap cannot spell", () => {
  expect(keyName({ meta: true, name: "f", sequence: "\x1bf" })).toBeUndefined();
  expect(keyName({ ctrl: true })).toBeUndefined();
  expect(keyName({})).toBeUndefined();
  expect(keyName({ sequence: "ab" })).toBeUndefined();
});

test("mouseEvent reads SGR presses, drags, releases, and wheels, declining the rest", () => {
  expect(mouseEvent("\x1b[<0;12;3M")).toEqual({ kind: "press", x: 12, y: 3 });
  expect(mouseEvent("\x1b[<32;12;4M")).toEqual({ kind: "drag", x: 12, y: 4 });
  expect(mouseEvent("\x1b[<0;12;4m")).toEqual({ kind: "release", x: 12, y: 4 });
  expect(mouseEvent("\x1b[<64;5;5M")).toEqual({ kind: "wheel", delta: -1 });
  expect(mouseEvent("\x1b[<65;5;5M")).toEqual({ kind: "wheel", delta: 1 });
  expect(mouseEvent("\x1b[<2;12;3M")).toBeUndefined();
  expect(mouseEvent("q")).toBeUndefined();
});
