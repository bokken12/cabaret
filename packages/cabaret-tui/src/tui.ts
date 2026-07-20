import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { type Backend, readConfig, UserError } from "cabaret-core";
import { type Page, renderPage, type Target, workspaceNotes } from "cabaret-views";
import { App, type Effects } from "./app.js";
import { type KeyEvent, keyName } from "./keys.js";
import { Screen } from "./screen.js";

/**
 * Visit a location target by suspending the TUI and opening `$EDITOR` on the
 * file within the change's workspace; a change checked out nowhere reports
 * instead.
 */
async function visitLocation(
  backend: Backend,
  screen: Screen,
  target: Extract<Target, { kind: "location" }>,
): Promise<string | undefined> {
  const note = (await workspaceNotes(backend)).get(target.change);
  if (note === undefined) {
    return `${target.change} is not checked out anywhere`;
  }
  const [editor, ...args] = (process.env.VISUAL ?? process.env.EDITOR ?? "vi").split(/\s+/);
  if (editor === undefined || editor.length === 0) {
    return "no editor: set $EDITOR";
  }
  screen.leave();
  process.stdin.setRawMode(false);
  try {
    const run = spawnSync(editor, [...args, `+${target.line}`, join(note.path, target.file)], { stdio: "inherit" });
    return run.error === undefined ? undefined : `could not run ${editor}: ${run.error.message}`;
  } finally {
    process.stdin.setRawMode(true);
    screen.enter();
  }
}

/** Open `url` in the system browser, detached so the TUI keeps the terminal. */
function openUrl(url: string): Promise<string | undefined> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.once("error", (error) => resolve(`could not open ${url}: ${error.message}`));
    child.once("spawn", () => {
      child.unref();
      resolve(undefined);
    });
  });
}

/** Run the TUI over `backend`, starting on `page`, until the user quits. */
export async function runTui(backend: Backend, page: Page = { kind: "home" }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserError("the TUI needs an interactive terminal");
  }
  const screen = new Screen(process.stdout);
  const effects: Effects = {
    visitLocation: (target) => visitLocation(backend, screen, target),
    openUrl,
  };
  const app = new App(
    async (target) => renderPage(backend, target, { context: (await readConfig(backend)).context }),
    screen,
    effects,
  );
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  screen.enter();
  const onResize = (): void => app.repaint();
  process.stdout.on("resize", onResize);
  try {
    await app.open(page);
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const settle = (finish: () => void): void => {
        done = true;
        finish();
      };
      // Keys queue behind one another: a render in flight finishes before
      // the next key acts, so frames never interleave. Ctrl+c skips the
      // queue — it must answer even when a render hangs.
      let turn = Promise.resolve();
      process.stdin.on("keypress", (_data: string | undefined, event: KeyEvent) => {
        if (event.ctrl === true && event.name === "c") {
          settle(resolve);
          return;
        }
        turn = turn.then(async () => {
          if (done) {
            return;
          }
          try {
            const key = keyName(event);
            if (key !== undefined && (await app.handleKey(key)) === "quit") {
              settle(resolve);
            }
          } catch (error) {
            settle(() => reject(error));
          }
        });
      });
    });
  } finally {
    process.stdout.off("resize", onResize);
    screen.leave();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
