/** A keypress as `node:readline` reports it. */
export interface KeyEvent {
  readonly name?: string | undefined;
  readonly sequence?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly shift?: boolean | undefined;
}

const NAMED: Readonly<Record<string, string>> = {
  return: "enter",
  enter: "enter",
  tab: "tab",
  escape: "esc",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  backspace: "backspace",
  space: "space",
};

/**
 * The keymap's name for a keypress: special keys by name, printable keys by
 * the character they type (so shifted keys read as what they produce: `R`,
 * `!`, `?`). Unnameable presses — bare modifiers, alt chords — are undefined.
 */
export function keyName(event: KeyEvent): string | undefined {
  if (event.ctrl === true) {
    return event.name === undefined ? undefined : `ctrl+${event.name}`;
  }
  // A lone Escape reports as meta — the byte also opens alt chords — so it
  // is named before meta declines the rest.
  if (event.name === "escape") {
    return "esc";
  }
  if (event.meta === true) {
    return undefined;
  }
  const named = event.name === undefined ? undefined : NAMED[event.name];
  if (named !== undefined) {
    return named;
  }
  const sequence = event.sequence;
  if (sequence !== undefined && [...sequence].length === 1 && sequence >= " " && sequence !== "\x7f") {
    return sequence;
  }
  return undefined;
}

/** A mouse event the terminal reports under SGR button tracking. */
export type MouseEvent =
  | { readonly kind: "press"; readonly x: number; readonly y: number }
  | { readonly kind: "drag"; readonly x: number; readonly y: number }
  | { readonly kind: "release"; readonly x: number; readonly y: number }
  | { readonly kind: "wheel"; readonly delta: -1 | 1 };

/**
 * The mouse event an SGR tracking sequence reports: `ESC [ < b ; x ; y M`,
 * final `m` for a release. Left presses, their drags (the motion bit while
 * held), releases, and wheel turns answer; other buttons are undefined.
 * `x` and `y` are 1-based cells.
 */
export function mouseEvent(sequence: string): MouseEvent | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape introduces the sequence
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (match === null) {
    return undefined;
  }
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (button === 64 || button === 65) {
    return { kind: "wheel", delta: button === 64 ? -1 : 1 };
  }
  if ((button & 3) !== 0) {
    return undefined;
  }
  if (match[4] === "m") {
    return { kind: "release", x, y };
  }
  return { kind: (button & 32) === 0 ? "press" : "drag", x, y };
}
