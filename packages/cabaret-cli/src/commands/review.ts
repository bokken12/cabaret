import { buildCommand } from "@stricli/core";
import { currentName, fileLabel, readConfig, renderDiff, renderDiff4, shortHash } from "cabaret-core";
import { changeSnapshot, type DiffPage, diffPage, emptyDiffNote, reviewDoc, reviewPage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { changeFlag, contextFlag, resolveChange, selectFiles, writeDoc } from "./shared.js";

/** One file's heading: where its diff reviews up to. */
function fileTitle(page: DiffPage): string {
  if (page.left === undefined) {
    return `${page.file} in ${page.change}`;
  }
  const name = fileLabel(page.file, page.left.source);
  return `${name} in ${page.change} (up to ${shortHash(page.left.tip)})`;
}

export const review = buildCommand({
  docs: {
    brief: "Show the diff of a change left for you to review",
    fullDescription:
      "Show the diff of a change left for you to review: the files with " +
      "review left, then each file's remaining diff. Arguments narrow what " +
      "is shown — a path, or a gitignore-style pattern against " +
      "repo-relative paths. What is shown is remembered, and `mark` records " +
      "review of it.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "files, directories, or patterns to show (defaults to everything left)",
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
    const change = await resolveChange(backend, flags.change);
    const snapshot = await changeSnapshot(backend, currentName(change.id, change.entries));
    const page = reviewPage(snapshot);
    // Conflicts preempt review, and a change with nothing left has nothing
    // to narrow: the page says so either way.
    if (page.conflicts.length > 0 || (page.left === undefined && args.length === 0)) {
      writeDoc(this, reviewDoc(page));
      return;
    }
    const files =
      args.length === 0
        ? (page.left?.files.map(({ path }) => path) ?? [])
        : selectFiles(backend, [...snapshot.left.keys()], args, false, "file with review left");
    let separate = false;
    if (page.left !== undefined) {
      const listed = page.left.files.filter(({ path }) => files.includes(path));
      if (listed.length > 0) {
        writeDoc(this, reviewDoc({ ...page, left: { ...page.left, files: listed } }));
        separate = true;
      }
    }
    // Stricli's process type omits isTTY, but the runtime process underneath has it.
    const color = (this.process.stdout as { isTTY?: boolean }).isTTY === true;
    const shown: string[] = [];
    for (const file of files) {
      const filePage = await diffPage(backend, snapshot, file);
      this.process.stdout.write(`${separate ? "\n" : ""}${fileTitle(filePage)}\n\n`);
      separate = true;
      if (filePage.left === undefined) {
        this.process.stdout.write("Nothing left to review.\n");
        continue;
      }
      shown.push(file);
      const view = filePage.left.view;
      const rendered =
        view.kind === "two"
          ? renderDiff(file, view.prev, view.next, color, context)
          : renderDiff4({ file, revs: view.revs, contents: view.contents, color, context })
              .map((line) => `${line.text}\n`)
              .join("");
      this.process.stdout.write(rendered === "" ? `${emptyDiffNote(filePage.left.source)}\n` : rendered);
    }
    if (shown.length === 0) {
      return;
    }
    // One runnable command, tip pinned to exactly what was shown.
    const changeArg = flags.change === undefined ? "" : ` --change ${flags.change}`;
    this.process.stdout.write("\nRecord review of what you have read:\n");
    this.process.stdout.write(`  cabaret mark${changeArg} --tip ${shortHash(snapshot.tip)} ${shown.join(" ")}\n`);
  },
});
