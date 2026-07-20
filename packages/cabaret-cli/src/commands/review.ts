import { buildCommand } from "@stricli/core";
import { fileLabel, type Revision, readConfig, renderDiff, renderDiff4, shortHash } from "cabaret-core";
import { changeSnapshot, type DiffPage, diffPage, reviewDoc, reviewPage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { changeFlag, contextFlag, pendingFiles, resolveChange, selectFiles, writeDoc } from "./shared.js";

/** One file's heading: where its diff reviews up to, and what still follows. */
function fileTitle(page: DiffPage): string {
  if (page.round === undefined) {
    return `${page.file} in ${page.change}`;
  }
  const { end, later, source } = page.round;
  const name = fileLabel(page.file, source);
  const more = later === 0 ? "" : `; ${later} more round${later === 1 ? "" : "s"} follow${later === 1 ? "s" : ""}`;
  return `${name} in ${page.change} (up to ${shortHash(end)}${more})`;
}

export const review = buildCommand({
  docs: {
    brief: "Show the diff of a change left for you to review",
    fullDescription:
      "Show the diff of a change left for you to review: the files of the " +
      "current review round, then each file's remaining diff. Arguments " +
      "narrow what is shown — a path, or a gitignore-style pattern against " +
      "repo-relative paths. What is shown is remembered, and `mark` records " +
      "review of it.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "files or patterns to show (defaults to the whole round)",
        placeholder: "file",
        parse: String,
      },
    },
    flags: {
      change: changeFlag("review"),
      context: contextFlag,
    },
  },
  async func(this: LocalContext, flags: { change?: string; context?: number }, ...args: string[]) {
    const backend = await this.backend();
    // Config is read even when the flag preempts it, so a misconfigured
    // cabaret.* key fails the same way on every invocation.
    const context = flags.context ?? (await readConfig(backend)).context;
    const { change } = await resolveChange(backend, flags.change);
    const snapshot = await changeSnapshot(backend, change);
    const page = reviewPage(snapshot);
    // Conflicts preempt the round, and a change with nothing left has
    // nothing to narrow: the page says so either way.
    if (page.conflicts.length > 0 || (page.round === undefined && args.length === 0)) {
      writeDoc(this, reviewDoc(page));
      return;
    }
    // No arguments show the current round; arguments select among every
    // pending file, so a later round's file can be asked for by name.
    const files =
      args.length === 0
        ? (page.round?.files.map(({ path }) => path) ?? [])
        : selectFiles(backend, pendingFiles(snapshot.rounds), args, false, "file with review left");
    let separate = false;
    if (page.round !== undefined) {
      const listed = page.round.files.filter(({ path }) => files.includes(path));
      if (listed.length > 0) {
        writeDoc(this, reviewDoc({ ...page, round: { ...page.round, files: listed } }));
        separate = true;
      }
    }
    // Stricli's process type omits isTTY, but the runtime process underneath has it.
    const color = (this.process.stdout as { isTTY?: boolean }).isTTY === true;
    const shown = new Map<string, Revision>();
    for (const file of files) {
      const filePage = await diffPage(backend, snapshot, file);
      this.process.stdout.write(`${separate ? "\n" : ""}${fileTitle(filePage)}\n\n`);
      separate = true;
      if (filePage.round === undefined) {
        this.process.stdout.write("Nothing left to review.\n");
        continue;
      }
      shown.set(file, filePage.round.end);
      const view = filePage.round.view;
      const rendered =
        view.kind === "two"
          ? renderDiff(file, view.prev, view.next, color, context)
          : renderDiff4({ file, revs: view.revs, contents: view.contents, color, context })
              .map((line) => `${line.text}\n`)
              .join("");
      // A due file's diff can still render empty — a tree diff lists changes
      // patdiff shows no hunks for, like a mode-only change; marking the
      // file reviewed is how the reviewer clears it.
      this.process.stdout.write(
        rendered === "" ? "No differences left to read; mark the file reviewed to record that.\n" : rendered,
      );
    }
    if (shown.size === 0) {
      return;
    }
    // One runnable command per displayed round end, tip pinned to exactly
    // what was shown.
    const ends = new Map<Revision, string[]>();
    for (const [file, end] of shown) {
      const group = ends.get(end);
      if (group === undefined) {
        ends.set(end, [file]);
      } else {
        group.push(file);
      }
    }
    const changeArg = flags.change === undefined ? "" : ` --change ${flags.change}`;
    this.process.stdout.write("\nRecord review of what you have read:\n");
    for (const [end, group] of ends) {
      this.process.stdout.write(`  cabaret mark${changeArg} --tip ${shortHash(end)} ${group.join(" ")}\n`);
    }
  },
});
