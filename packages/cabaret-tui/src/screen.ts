import type { CursorCell, Terminal } from "./app.js";
import type { ColorDepth } from "./paint.js";

/** The terminal's color depth, read from the environment. */
export function colorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  const colorterm = env.COLORTERM ?? "";
  return colorterm.includes("truecolor") || colorterm.includes("24bit") ? "truecolor" : "ansi256";
}

/**
 * The real terminal behind the app: frames paint on the alternate screen,
 * so quitting restores the shell exactly as it was. Each render hides the
 * terminal's cursor, homes, rewrites every row — erasing to the right of
 * each and below the last, simple full-frame paint, cheap at viewport size —
 * then parks the cursor where the app says and shows it: the terminal's own
 * cursor is the app's.
 */
export class Screen implements Terminal {
  readonly depth: ColorDepth;
  private active = false;

  constructor(private readonly out: NodeJS.WriteStream) {
    this.depth = colorDepth(process.env);
  }

  // A terminal that does not report its size (some pseudo-terminals) reads
  // as zero; classic dimensions stand in.
  columns(): number {
    return this.out.columns > 0 ? this.out.columns : 80;
  }

  rows(): number {
    return this.out.rows > 0 ? this.out.rows : 24;
  }

  // Button tracking (clicks and drags) with SGR encoding rides along with the alternate screen;
  // the terminal's own drag-selection stays available behind shift.
  enter(): void {
    this.active = true;
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[?1002;1006h\x1b[2J\x1b[H");
  }

  leave(): void {
    this.active = false;
    this.out.write("\x1b[?1002;1006l\x1b[0m\x1b[?25h\x1b[?1049l");
  }

  render(rows: readonly string[], cursor: CursorCell): void {
    // A frame from work still in flight when the alternate screen closed
    // must not spill onto the shell.
    if (!this.active) {
      return;
    }
    this.out.write(
      `\x1b[?25l\x1b[H${rows.map((row) => `${row}\x1b[K`).join("\r\n")}\x1b[0J` +
        `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`,
    );
  }
}
