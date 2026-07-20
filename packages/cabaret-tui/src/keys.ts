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
