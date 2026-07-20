/** The slice of a `KeyboardEvent` key naming reads. */
export interface KeyStroke {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

const NAMED: Readonly<Record<string, string>> = {
  Enter: "enter",
  Tab: "tab",
  Escape: "esc",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/**
 * The keymap's name for a keypress: special keys by name, printable keys by
 * the character they type (so shifted keys read as what they produce: `R`,
 * `?`). Presses the keymap never binds — bare modifiers, alt and meta
 * chords — are undefined, left to the browser.
 */
export function keyName(stroke: KeyStroke): string | undefined {
  if (stroke.altKey || stroke.metaKey) {
    return undefined;
  }
  if (stroke.ctrlKey) {
    return [...stroke.key].length === 1 ? `ctrl+${stroke.key.toLowerCase()}` : undefined;
  }
  const named = NAMED[stroke.key];
  if (named !== undefined) {
    return named;
  }
  return [...stroke.key].length === 1 && stroke.key >= " " ? stroke.key : undefined;
}
