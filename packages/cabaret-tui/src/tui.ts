import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import {
  addChangeWorkspace,
  type Backend,
  type ChangeName,
  createChange,
  currentArchived,
  currentParent,
  currentSelf,
  type Forge,
  fetchForge,
  fetchLocal,
  gotoChange,
  knownChanges,
  type LogEntry,
  landAsConfigured,
  landChain,
  readConfig,
  rebaseChain,
  rebaseChange,
  reclaimWorkspaces,
  removeChangeWorkspace,
  reparentChange,
  resolveChain,
  setArchived,
  setReviewing,
  syncChange,
  type TimestampMs,
  timestampMs,
  transferChange,
  UserError,
  userName,
  widenReviewing,
} from "cabaret-core";
import { NoForgeError, openForge as openRepositoryForge } from "cabaret-node";
import { mapConcurrent } from "cabaret-util";
import {
  type ChangeSnapshot,
  markReviewed,
  type Page,
  reclaimNote,
  renderPage,
  type Target,
  type ViewedDiffs,
  workspaceNotes,
} from "cabaret-views";
import { App, type Effects, type Source } from "./app.js";
import { type KeyEvent, keyName, mouseEvent } from "./keys.js";
import { Screen } from "./screen.js";

const now = (): TimestampMs => timestampMs(Date.now());

/** Concurrent change-log reads, matching the home page's fan-out. */
const READ_CONCURRENCY = 8;

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
  const openForge = (): Promise<Forge> => openRepositoryForge(backend.root);
  /** The forge when one is configured here; plenty of repositories have none. */
  const forgeIfAny = async (): Promise<Forge | undefined> => {
    try {
      return await openForge();
    } catch (error) {
      if (error instanceof NoForgeError) {
        return undefined;
      }
      throw error;
    }
  };
  const effects: Effects = {
    visitLocation: (target) => visitLocation(backend, screen, target),
    openUrl,
    mark: (snapshot, file, evenThoughNotReviewing) =>
      Promise.resolve(markReviewed(backend, now, snapshot, file, evenThoughNotReviewing)),
    parent: async (change) => {
      const entries = await backend.readLog(change);
      return entries.length === 0 ? undefined : currentParent(change, entries);
    },
    self: () => currentSelf(backend),
    children: async (change) => {
      const all = await backend.listChanges();
      const parents = await mapConcurrent(all, READ_CONCURRENCY, async (other) => ({
        other,
        parent: currentParent(other, await backend.readLog(other)),
      }));
      return parents
        .filter(({ parent }) => parent === change)
        .map(({ other }) => other)
        .sort();
    },
    rebase: async (changes, overrides) => {
      const only = changes.length === 1 ? changes[0] : undefined;
      if (only !== undefined) {
        await rebaseChange(backend, now, only, await backend.readLog(only), overrides);
      } else {
        await rebaseChain(backend, now, await resolveChain(backend, changes), overrides);
      }
    },
    land: async (changes, overrides) => {
      const config = await readConfig(backend);
      const landOne = async (change: ChangeName, entries: readonly LogEntry[]): Promise<void> => {
        await landAsConfigured(backend, now, openForge, config, change, entries, overrides);
      };
      const only = changes.length === 1 ? changes[0] : undefined;
      if (only !== undefined) {
        await landOne(only, await backend.readLog(only));
      } else {
        await landChain(backend, await resolveChain(backend, changes), landOne);
      }
    },
    reparent: async (change, parent, evenThoughNotOwner) => {
      await reparentChange(backend, now, change, parent, {
        notOwner: evenThoughNotOwner,
        parentArchived: false,
        parentDiverged: false,
      });
    },
    setOwner: (change, owner, evenThoughNotOwner) =>
      transferChange(backend, now, change, userName(owner), evenThoughNotOwner),
    widenReviewing: async (change) => {
      const { to } = await widenReviewing(backend, now, change, await backend.readLog(change));
      return to;
    },
    disableReviewing: async (change) => {
      await setReviewing(backend, now, change, await backend.readLog(change), "none");
    },
    toggleArchived: async (change) => {
      const entries = await backend.readLog(change);
      const archived = !currentArchived(entries);
      await setArchived(backend, now, change, entries, archived);
      return archived;
    },
    gotoWorkspace: async (change, evenThoughDirty) => {
      const config = await readConfig(backend);
      const result = await gotoChange(backend, config, change, evenThoughDirty);
      return result.kind === "checked-out"
        ? `checked out ${change}`
        : result.path === backend.root
          ? `${change} is checked out in this workspace`
          : `${change} is checked out at ${result.path}`;
    },
    addWorkspace: (change) => addChangeWorkspace(backend, change),
    removeWorkspace: (change, evenThoughDirty) => removeChangeWorkspace(backend, change, evenThoughDirty),
    reclaimWorkspaces: async () => reclaimNote(await reclaimWorkspaces(backend, false)),
    create: async (name, parent) => {
      await createChange(backend, now, name, parent, false);
    },
    changes: () => knownChanges(backend),
    parseName: (raw) => backend.parseName(raw),
    fetch: async () => {
      const forge = await forgeIfAny();
      // Without a forge, the origin half still runs.
      if (forge === undefined) {
        const { synced } = await fetchLocal(backend);
        return `synced ${synced.length} change${synced.length === 1 ? "" : "s"} with origin`;
      }
      const { coverage, swept } = await fetchForge(backend, now, forge, () => {});
      const kind = coverage === "open" ? "open" : "updated";
      return `fetched ${forge.locator}, ${swept} ${kind} forge change${swept === 1 ? "" : "s"}`;
    },
    sync: async (change) => {
      const forge = await forgeIfAny();
      const result = await syncChange(backend, now, forge, change);
      const conflicts = result.joined?.conflicts ?? [];
      const offline = result.offline ? "; origin unreachable \u2014 sync again online to publish" : "";
      if (conflicts.length > 0) {
        return `merged origin's copy of ${change} with conflicts in ${conflicts.join(", ")}; fix the markers and amend${offline}`;
      }
      if (result.offline) {
        return "origin unreachable; synced locally \u2014 sync again online to publish";
      }
      return result.published === undefined
        ? `synced ${change}`
        : `synced ${change} to ${forge?.locator}#${result.published.id}`;
    },
  };
  const source: Source = async (target) => {
    let snapshot: ChangeSnapshot | undefined;
    let viewed: ViewedDiffs | undefined;
    const doc = await renderPage(backend, target, {
      context: (await readConfig(backend)).context,
      onSnapshot: (read) => {
        snapshot = read;
      },
      onViewed: (shown) => {
        viewed = shown;
      },
    });
    return { doc, snapshot, viewed };
  };
  const app = new App(source, screen, effects);
  // Mouse tracking sequences would reach the keypress decoder as fragments
  // it types back as stray keys, so they are cut from the byte stream first
  // and only the remainder feeds the decoder.
  const keyStream = new PassThrough();
  emitKeypressEvents(keyStream);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  screen.enter();
  const onResize = (): void => app.repaint();
  process.stdout.on("resize", onResize);
  let onData: ((chunk: Buffer) => void) | undefined;
  try {
    await app.open(page);
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const settle = (finish: () => void): void => {
        done = true;
        finish();
      };
      // Keys and clicks queue behind one another: a render in flight
      // finishes before the next one acts, so frames never interleave.
      // Ctrl+c skips the queue — it must answer even when a render hangs.
      let turn = Promise.resolve();
      const enqueue = (act: () => Promise<void>): void => {
        turn = turn.then(async () => {
          if (done) {
            return;
          }
          try {
            await act();
          } catch (error) {
            settle(() => reject(error));
          }
        });
      };
      let carry = "";
      onData = (chunk: Buffer): void => {
        const data = carry + chunk.toString("utf8");
        carry = "";
        let keys = "";
        let last = 0;
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape introduces the sequence
        for (const match of data.matchAll(/\x1b\[<\d+;\d+;\d+[Mm]/g)) {
          keys += data.slice(last, match.index);
          last = match.index + match[0].length;
          const mouse = mouseEvent(match[0]);
          if (mouse !== undefined) {
            enqueue(() => app.handleMouse(mouse));
          }
        }
        keys += data.slice(last);
        // A sequence split across reads waits for its remainder; only a
        // mouse prefix holds back, so a lone escape still types.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape introduces the sequence
        const partial = /\x1b\[<[\d;]*$/.exec(keys);
        if (partial !== null) {
          carry = keys.slice(partial.index);
          keys = keys.slice(0, partial.index);
        }
        if (keys.length > 0) {
          keyStream.write(keys);
        }
      };
      process.stdin.on("data", onData);
      keyStream.on("keypress", (_data: string | undefined, event: KeyEvent) => {
        if (event.ctrl === true && event.name === "c") {
          settle(resolve);
          return;
        }
        enqueue(async () => {
          const key = keyName(event);
          if (key !== undefined && (await app.handleKey(key)) === "quit") {
            settle(resolve);
          }
        });
      });
    });
  } finally {
    if (onData !== undefined) {
      process.stdin.off("data", onData);
    }
    process.stdout.off("resize", onResize);
    screen.leave();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
