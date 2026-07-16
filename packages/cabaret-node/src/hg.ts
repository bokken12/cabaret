import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile as readFsFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type ConfigScope,
  type FilePath,
  formatLogEntry,
  LAND_TRAILER,
  type LandMerge,
  type LogEntry,
  mergeLogs,
  parseFilePath,
  parseLog,
  type Recommendation,
  type RefName,
  type Revision,
  shortHash,
  UserError,
  type UserName,
  userName,
  VcsUnavailableError,
  type Workspace,
} from "cabaret-core";
import type { Branded } from "cabaret-util";
import { mergeDiff3 } from "node-diff3";

const execFileAsync = promisify(execFile);

/** A full (non-abbreviated) Mercurial changeset id: the hg backend's `Revision`. Obtain via `parseHgNode`. */
export type HgNode = Branded<Revision, "HgNode">;

const HG_NODE = /^[0-9a-f]{40}$/;

/** The all-zeros id of hg's null revision: what revset functions yield for "no revision". */
const NULL_NODE = "0".repeat(40);

export function parseHgNode(raw: string): HgNode {
  if (!HG_NODE.test(raw) || raw === NULL_NODE) {
    throw new Error(`not an hg changeset id: ${JSON.stringify(raw)}`);
  }
  return raw as HgNode;
}

/** There is no `hg` to run: nothing on PATH answers to the name. */
export class HgUnavailableError extends VcsUnavailableError {
  constructor() {
    super(
      "hg not found on PATH; install it from https://www.mercurial-scm.org (on macOS: brew install mercurial)",
      "https://www.mercurial-scm.org/install",
    );
  }
}

/**
 * Run hg in `cwd` and return its stdout. HGPLAIN keeps the output stable
 * against user aliases, localization, and tweaked defaults. On nonzero exit
 * the rejection already names the command and carries stderr in its message.
 */
async function hg(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("hg", args, {
      cwd,
      maxBuffer: 1024 ** 3,
      env: { ...process.env, HGPLAIN: "1" },
    });
    return stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new HgUnavailableError();
    }
    throw error;
  }
}

/** Whether a rejection from `hg()` reported output matching `pattern`, on either stream. */
function aborted(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { stdout, stderr } = error as { stdout?: string; stderr?: string };
  return pattern.test(`${stdout ?? ""}\n${stderr ?? ""}\n${error.message}`);
}

/**
 * Where a change's log lives: a chain of commits rooted at hg's null
 * revision, so it shares no history with the code, each holding the full log
 * text in a single `log` file. The movable pointer to the chain's tip is the
 * `LOG_BOOKMARK_PREFIX` bookmark; the chain also carries a per-change named
 * branch, purely so hg's push-time head counting sees each change's log as
 * its own branch instead of refusing sibling logs as "new remote heads".
 * Named branches are permanent, so a renamed or deleted change leaves its
 * branch label behind on old commits — only the bookmark is ever read.
 * Log commits stay in the secret phase until a sync publishes them, so the
 * user's own `hg push` never trips over them.
 */
const LOG_BOOKMARK_PREFIX = "cabaret/log/";

/** The named branch of a change's log commits; disjoint from the bookmark namespace, which hg requires. */
const LOG_BRANCH_PREFIX = "cabaret/logs/";

function logBookmark(change: RefName): string {
  return `${LOG_BOOKMARK_PREFIX}${change}`;
}

/** Path of the log file within a log commit. */
const LOG_PATH = "log";

/** The remote every remote operation uses: hg's counterpart of git's `origin`. */
const ORIGIN_PATH = "default";

/** One file's part in a computed content merge. */
interface MergedFile {
  readonly path: FilePath;
  /** The contents the merge resolves to; undefined removes the file. */
  readonly content: string | undefined;
  /** Whether the resolution carries conflict markers (or is a delete/edit conflict). */
  readonly conflict: boolean;
}

/** Split file contents into the lines node-diff3 merges; joining with "\n" inverts it. */
function lines(content: string): string[] {
  return content.split("\n");
}

/** A `Backend` that shells out to a local `hg` (Mercurial). */
export class HgBackend implements Backend<HgNode> {
  readonly vcs = "hg";

  readonly parseRevision = parseHgNode;

  private constructor(
    readonly root: string,
    /** Repo-relative path of the directory the backend was opened from: "" at the root, "src/" below it. */
    private readonly prefix: string,
  ) {}

  /** Open the hg repository containing `dir`. */
  static async open(dir: string): Promise<HgBackend> {
    const root = (await hg(dir, ["root"])).trimEnd();
    // hg has no `--show-prefix`; resolving both paths keeps symlinked
    // spellings of the same directory from producing a bogus prefix.
    const prefix = relative(await realpath(root), await realpath(dir));
    return new HgBackend(root, prefix === "" ? "" : `${prefix}${sep}`);
  }

  private hgDir(): string {
    return join(this.root, ".hg");
  }

  resolveFile(raw: string): FilePath {
    // Check the raw spelling too: "" would otherwise normalize into a
    // plausible-looking directory path instead of failing.
    parseFilePath(raw);
    const path = normalize(isAbsolute(raw) ? relative(this.root, raw) : join(this.prefix, raw));
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new UserError(`path is outside the repository: ${JSON.stringify(raw)}`);
    }
    return parseFilePath(path);
  }

  /** The active bookmark, or undefined when none is active — hg's detached HEAD. */
  private async activeBookmark(): Promise<RefName | undefined> {
    const out = await hg(this.root, ["log", "-r", "wdir()", "-T", "{activebookmark}"]);
    return out === "" ? undefined : (out as RefName);
  }

  async currentBranch(): Promise<RefName> {
    const active = await this.activeBookmark();
    if (active === undefined) {
      throw new UserError("no bookmark is active; check out a change (hg update <bookmark>) or name it explicitly");
    }
    return active;
  }

  async currentUser(): Promise<UserName> {
    const raw = await this.config("ui.username");
    if (raw === undefined || raw === "") {
      throw new UserError("hg config ui.username is not set; log entries need an identity");
    }
    // The conventional "Name <email>" form identifies by the email, matching
    // what the git backend attributes entries to.
    const email = /<([^>]+)>/.exec(raw)?.[1];
    return userName(email ?? raw);
  }

  async config(key: string): Promise<string | undefined> {
    try {
      const out = await hg(this.root, ["config", key]);
      return out.trimEnd();
    } catch (error) {
      // Exit code 1 means exactly "unset"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }

  // hgrc has no repeated-key values, so multi-valued keys hold one
  // comma-separated list, hg's own list syntax. Values Cabaret stores in
  // them (aliases: email addresses) cannot contain commas.
  private static splitList(value: string | undefined): readonly string[] {
    if (value === undefined) {
      return [];
    }
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  /**
   * The file a scope's config lives in. Tests point HGRCPATH at a single
   * file, which then serves as the person's global config; hg itself accepts
   * a search path there, of which this honors the first entry.
   */
  private configFile(scope: ConfigScope): string {
    if (scope === "local") {
      return join(this.hgDir(), "hgrc");
    }
    const hgrcPath = process.env.HGRCPATH;
    if (hgrcPath !== undefined && hgrcPath !== "") {
      const first = hgrcPath.split(":")[0];
      if (first !== undefined && first !== "") {
        return first;
      }
    }
    return join(homedir(), ".hgrc");
  }

  private async readConfigFile(scope: ConfigScope): Promise<string> {
    try {
      return await readFsFile(this.configFile(scope), "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  /** The `section` and `name` of a dotted config key. */
  private static splitKey(key: string): { section: string; name: string } {
    const dot = key.indexOf(".");
    if (dot <= 0 || dot === key.length - 1) {
      throw new Error(`not a section.name config key: ${JSON.stringify(key)}`);
    }
    return { section: key.slice(0, dot), name: key.slice(dot + 1) };
  }

  /** The value of `key` in an hgrc text, or undefined. Within a file, hg lets the last assignment win. */
  private static iniGet(text: string, key: string): string | undefined {
    const { section, name } = HgBackend.splitKey(key);
    let inSection = false;
    let found: string | undefined;
    for (const line of text.split("\n")) {
      const header = /^\s*\[(.*)\]\s*$/.exec(line);
      if (header !== null) {
        inSection = header[1] === section;
        continue;
      }
      if (!inSection) {
        continue;
      }
      const assign = /^\s*([^=#;][^=]*?)\s*=(.*)$/.exec(line);
      if (assign !== null && assign[1] === name) {
        found = (assign[2] ?? "").trim();
      }
    }
    return found;
  }

  /**
   * `text` with `key` set to `value` (or removed, when undefined): existing
   * assignments of the key are dropped, and a set lands at the end of the
   * key's section, appended as a new section when there is none.
   */
  private static iniSet(text: string, key: string, value: string | undefined): string {
    const { section, name } = HgBackend.splitKey(key);
    const kept: string[] = [];
    let inSection = false;
    let sectionEnd = -1;
    for (const line of text.split("\n")) {
      const header = /^\s*\[(.*)\]\s*$/.exec(line);
      if (header !== null) {
        inSection = header[1] === section;
        kept.push(line);
        if (inSection) {
          sectionEnd = kept.length;
        }
        continue;
      }
      if (inSection) {
        const assign = /^\s*([^=#;][^=]*?)\s*=(.*)$/.exec(line);
        if (assign !== null && assign[1] === name) {
          continue;
        }
        if (line.trim() !== "") {
          sectionEnd = kept.length + 1;
        }
      }
      kept.push(line);
    }
    if (value === undefined) {
      return kept.join("\n");
    }
    const assignment = `${name} = ${value}`;
    if (sectionEnd === -1) {
      const body = kept.join("\n");
      const separator = body === "" || body.endsWith("\n") ? "" : "\n";
      return `${body}${separator}[${section}]\n${assignment}\n`;
    }
    kept.splice(sectionEnd, 0, assignment);
    return kept.join("\n");
  }

  private async writeConfig(scope: ConfigScope, key: string, value: string | undefined): Promise<void> {
    const text = await this.readConfigFile(scope);
    await mkdir(dirname(this.configFile(scope)), { recursive: true });
    await writeFile(this.configFile(scope), HgBackend.iniSet(text, key, value));
  }

  async configAll(key: string, scope?: ConfigScope): Promise<readonly string[]> {
    if (scope === undefined) {
      return HgBackend.splitList(await this.config(key));
    }
    return HgBackend.splitList(HgBackend.iniGet(await this.readConfigFile(scope), key));
  }

  async configSet(key: string, value: string, scope: ConfigScope): Promise<void> {
    await this.writeConfig(scope, key, value);
  }

  async configAdd(key: string, value: string, scope: ConfigScope): Promise<void> {
    const values = [...(await this.configAll(key, scope)), value];
    await this.writeConfig(scope, key, values.join(", "));
  }

  async configUnset(key: string, scope: ConfigScope, value?: string): Promise<boolean> {
    const values = await this.configAll(key, scope);
    // A key set to the empty value has no list items but still exists.
    const exists = HgBackend.iniGet(await this.readConfigFile(scope), key) !== undefined;
    if (!exists) {
      return false;
    }
    if (value === undefined) {
      await this.writeConfig(scope, key, undefined);
      return true;
    }
    const kept = values.filter((item) => item !== value);
    if (kept.length === values.length) {
      return false;
    }
    await this.writeConfig(scope, key, kept.length === 0 ? undefined : kept.join(", "));
    return true;
  }

  setupRecommendations(): readonly Recommendation[] {
    return [
      {
        key: "extensions.remotenames",
        value: "",
        scope: "global",
        multi: false,
        brief: "tracking origin's bookmarks, so stale-state checks see what was last fetched",
      },
    ];
  }

  async resolveCommit(expression: string): Promise<HgNode> {
    let out: string;
    try {
      out = await hg(this.root, ["log", "-r", expression, "-T", "{node}\n"]);
    } catch (error) {
      if (aborted(error, /unknown revision|parse error|not found in repository/)) {
        throw new UserError(`unknown revision: ${JSON.stringify(expression)}`);
      }
      throw error;
    }
    const nodes = out.split("\n").filter((line) => line !== "");
    const node = nodes[0];
    if (node === undefined || nodes.length > 1) {
      throw new UserError(`revision names ${nodes.length} revisions, not one: ${JSON.stringify(expression)}`);
    }
    return parseHgNode(node);
  }

  /** Every bookmark and the node it points at. */
  private async bookmarks(): Promise<ReadonlyMap<string, HgNode>> {
    // remotenames, when enabled (Cabaret's own setup recommends it), folds
    // records of origin's bookmarks into template listings under
    // default/-prefixed names; only real bookmarks belong here, so the
    // extension is forced off for the read.
    const out = await hg(this.root, [
      "bookmarks",
      "--config",
      "extensions.remotenames=!",
      "-T",
      "{bookmark}\\0{node}\\0",
    ]);
    const fields = out.split("\0").slice(0, -1);
    const marks = new Map<string, HgNode>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      marks.set(fields[i] as string, parseHgNode(fields[i + 1] as string));
    }
    return marks;
  }

  async branchTip(branch: RefName): Promise<HgNode | undefined> {
    return (await this.bookmarks()).get(branch);
  }

  async originTip(branch: RefName): Promise<HgNode | undefined> {
    return this.remoteReading(branch);
  }

  /**
   * The node the remotenames extension recorded for origin's `bookmark` when
   * last exchanged. The extension is bundled with hg and Cabaret enables it
   * on its own pulls and pushes; a repository that never exchanged through it
   * simply has no reading, which `originTip`'s contract allows.
   *
   * Read straight from the extension's versioned store: its template view
   * joins the remote key and bookmark name with "/", which a slashed
   * bookmark name counterfeits (the `cabaret/log/gadget` record reads as a
   * reading of a code bookmark `gadget` under a key ending `/cabaret/log`),
   * while the store keeps them as separate fields. Records of any key count:
   * hg keys them by the `default` alias or the resolved URL depending on how
   * the path was spelled, and every exchange here uses the one pinned origin.
   */
  private async remoteReading(bookmark: string): Promise<HgNode | undefined> {
    let text: string;
    try {
      text = await readFsFile(join(this.hgDir(), "logexchange", "bookmarks"), "utf8");
    } catch (error) {
      // No file means nothing was ever recorded.
      if ((error as { code?: unknown }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const [version, blank, ...records] = text.split("\n");
    if (version !== "0" || blank !== "") {
      throw new Error(`unrecognized hg logexchange format: ${JSON.stringify(version)}`);
    }
    for (const record of records) {
      const [node, , name] = record.split("\0");
      if (node !== undefined && name === bookmark) {
        return parseHgNode(node);
      }
    }
    return undefined;
  }

  async createBranch(name: RefName, commit: HgNode): Promise<void> {
    // `hg bookmark` moves an existing bookmark rather than failing, and hg
    // has no compare-and-swap for them, so existence is checked first; the
    // remaining race loses no commits, only a bookmark position.
    if ((await this.branchTip(name)) !== undefined) {
      throw new UserError(`branch already exists: ${JSON.stringify(name)}`);
    }
    await hg(this.root, ["bookmark", "-r", commit, "--", name]);
  }

  async workspaces(): Promise<readonly Workspace[]> {
    // TODO: dedicated workspaces would map onto `hg share`, but hg keeps no
    // registry of a repository's shares to enumerate; grow one here when a
    // real hg user wants `cabaret workspace`.
    const [branch, status] = await Promise.all([this.activeBookmark(), hg(this.root, ["status"])]);
    return [{ path: this.root, branch, dirty: status !== "", primary: true }];
  }

  async addWorkspace(_path: string, _branch: RefName): Promise<void> {
    throw new UserError("the hg backend does not support dedicated workspaces");
  }

  async removeWorkspace(_path: string, _force: boolean): Promise<void> {
    throw new UserError("the hg backend does not support dedicated workspaces");
  }

  async checkout(branch: RefName): Promise<void> {
    if ((await this.branchTip(branch)) === undefined) {
      throw new UserError(`branch does not exist: ${JSON.stringify(branch)}`);
    }
    // Updating to a bookmark by name activates it; local edits merge along,
    // and hg aborts when one would be overwritten.
    await hg(this.root, ["update", "-q", "--", branch]);
  }

  async renameChange(from: RefName, to: RefName): Promise<void> {
    if ((await this.branchTip(from)) === undefined) {
      throw new UserError(`branch does not exist: ${JSON.stringify(from)}`);
    }
    const marks = await this.bookmarks();
    if (!marks.has(logBookmark(from))) {
      throw new Error(`change has no log: ${JSON.stringify(from)}`);
    }
    if (marks.has(to) || marks.has(logBookmark(to))) {
      throw new UserError(`branch or log already exists: ${JSON.stringify(to)}`);
    }
    // Two renames, not one transaction: hg has no multi-bookmark transaction,
    // so a crash between them strands the change under two names — visibly,
    // and mendable by renaming the log bookmark by hand.
    // `bookmark -m` rejects a "--" separator outright, so the names ride bare.
    await hg(this.root, ["bookmark", "-m", from, to]);
    await hg(this.root, ["bookmark", "-m", logBookmark(from), logBookmark(to)]);
  }

  /** The single node `revset` names, or undefined when it names none. */
  private async revsetNode(revset: string): Promise<HgNode | undefined> {
    const out = await hg(this.root, ["log", "-r", revset, "-T", "{node}\n"]);
    const node = out.split("\n").find((line) => line !== "");
    return node === undefined || node === NULL_NODE ? undefined : parseHgNode(node);
  }

  async mergeBase(a: HgNode, b: HgNode): Promise<HgNode> {
    const found = await this.revsetNode(`ancestor(${a}, ${b})`);
    if (found === undefined) {
      throw new Error(`no common ancestor of ${a} and ${b}`);
    }
    return found;
  }

  async isAncestor(ancestor: HgNode, descendant: HgNode): Promise<boolean> {
    return (await this.revsetNode(`ancestor(${ancestor}, ${descendant})`)) === ancestor;
  }

  async mergedTip(merge: HgNode): Promise<HgNode> {
    const out = await hg(this.root, ["log", "-r", merge, "-T", "{p2node}"]);
    if (out === NULL_NODE) {
      throw new Error(`not a merge commit: ${merge}`);
    }
    return parseHgNode(out);
  }

  async readFile(commit: HgNode, file: FilePath): Promise<string | undefined> {
    let out: string;
    try {
      // `path:` matches the literal path — but as a prefix, so a directory
      // matches every file under it; the echoed path telling ours apart.
      out = await hg(this.root, ["cat", "-r", commit, "-T", "{path}\\0{data}", `path:${file}`]);
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
    const boundary = out.indexOf("\0");
    if (boundary === -1 || out.slice(0, boundary) !== file) {
      throw new Error(`not a file: ${JSON.stringify(file)} at ${shortHash(commit)} is a directory`);
    }
    return out.slice(boundary + 1);
  }

  async changedFiles(base: HgNode, tip: HgNode): Promise<readonly FilePath[]> {
    // hg reports a move as a remove plus an add unless asked to trace
    // copies, so each path names the same file on both sides. Subrepo state
    // files (.hgsub*) are ordinary files and stay listed.
    const out = await hg(this.root, ["status", "--rev", base, "--rev", tip, "-T", "{path}\\0"]);
    return out
      .split("\0")
      .filter((path) => path !== "")
      .map(parseFilePath);
  }

  async landMerges(base: HgNode, tip: HgNode): Promise<readonly LandMerge<HgNode>[]> {
    // `only(tip, base)` is everything in tip's history and not base's; the
    // first-parent chain is walked here, from the fetched parent links.
    const out = await hg(this.root, ["log", "-r", `only(${tip}, ${base})`, "-T", "{node}\\t{p1node}\\t{desc|json}\\n"]);
    const commits = new Map<string, { p1: string; desc: string }>();
    for (const line of out.split("\n")) {
      if (line === "") {
        continue;
      }
      const [node, p1, descJson] = line.split("\t");
      if (node === undefined || p1 === undefined || descJson === undefined) {
        throw new Error(`malformed hg log line: ${JSON.stringify(line)}`);
      }
      commits.set(node, { p1, desc: JSON.parse(descJson) as string });
    }
    const merges: LandMerge<HgNode>[] = [];
    for (let cursor: string = tip; ; ) {
      const commit = commits.get(cursor);
      if (commit === undefined) {
        break;
      }
      // A land merge's onto is its first parent; a squash land's, its sole
      // parent. As in the git backend, the trailer is trusted wherever it
      // appears in the message's lines.
      if (commit.desc.split("\n").some((line) => line.startsWith(`${LAND_TRAILER}: `))) {
        merges.push({ commit: parseHgNode(cursor), onto: parseHgNode(commit.p1) });
      }
      cursor = commit.p1;
    }
    return merges.reverse();
  }

  // ---- worker: a hidden share where commits and merges are built ----

  /**
   * The worker: a share of this repository (same store, own working
   * directory) hidden under `.hg/cabaret`, where log commits and merge trees
   * are built without ever touching the user's working directory. hg offers
   * no tree-construction plumbing like git's `commit-tree`, so a working
   * directory it is. One worker serves one backend; concurrent Cabaret
   * processes race benignly, retrying at the bookmark move.
   */
  private async worker(): Promise<string> {
    const dir = join(this.hgDir(), "cabaret", "worker");
    if (!existsSync(join(dir, ".hg"))) {
      await mkdir(dirname(dir), { recursive: true });
      await hg(this.root, ["--config", "extensions.share=", "share", "-q", "-U", this.root, dir]);
    }
    return dir;
  }

  /** Run hg in the worker; shares need the share extension enabled to be read at all. */
  private async hgWorker(args: readonly string[]): Promise<string> {
    return hg(await this.worker(), ["--config", "extensions.share=", ...args]);
  }

  /** Reset the worker's working directory to `node` (or empty, for the null revision), clearing strays from failed runs. */
  private async workerReset(node: HgNode | "null"): Promise<void> {
    await this.hgWorker(["update", "-q", "-C", "-r", node]);
    const unknown = await this.hgWorker(["status", "-u", "-T", "{path}\\0"]);
    const dir = await this.worker();
    for (const path of unknown.split("\0")) {
      if (path !== "") {
        await unlink(join(dir, path));
      }
    }
  }

  /** The node the worker's working directory sits on after a commit. */
  private async workerNode(): Promise<HgNode> {
    return parseHgNode((await this.hgWorker(["log", "-r", ".", "-T", "{node}"])).trimEnd());
  }

  /** Commit the worker's working directory as a log commit: secret until a sync publishes it. */
  private async commitLogState(): Promise<HgNode> {
    await this.hgWorker([
      "commit",
      "-q",
      "--config",
      "phases.new-commit=secret",
      "--config",
      // Log commits are bookkeeping; the entries inside carry the real identities.
      "ui.username=cabaret",
      "-m",
      "cabaret log",
    ]);
    return this.workerNode();
  }

  /** Write the log file in the worker atop `parent` (fresh on the change's log branch when undefined) and commit it. */
  private async commitLog(change: RefName, parent: HgNode | undefined, text: string): Promise<HgNode> {
    if (parent === undefined) {
      await this.workerReset("null");
      // -f: recreating a deleted change reuses its permanent branch name.
      await this.hgWorker(["branch", "-q", "-f", `${LOG_BRANCH_PREFIX}${change}`]);
      await writeFile(join(await this.worker(), LOG_PATH), text);
      await this.hgWorker(["add", "-q", `path:${LOG_PATH}`]);
    } else {
      await this.workerReset(parent);
      await writeFile(join(await this.worker(), LOG_PATH), text);
    }
    return this.commitLogState();
  }

  // ---- logs ----

  async listChanges(): Promise<readonly RefName[]> {
    return [...(await this.bookmarks()).keys()]
      .filter((name) => name.startsWith(LOG_BOOKMARK_PREFIX))
      .map((name) => name.slice(LOG_BOOKMARK_PREFIX.length) as RefName)
      .sort();
  }

  /** The raw log text at log commit `node`. */
  private async logText(node: HgNode): Promise<string> {
    const text = await this.readFile(node, parseFilePath(LOG_PATH));
    if (text === undefined) {
      throw new Error(`log commit has no ${LOG_PATH} file: ${node}`);
    }
    return text;
  }

  async readLog(change: RefName): Promise<readonly LogEntry<HgNode>[]> {
    const tip = (await this.bookmarks()).get(logBookmark(change));
    if (tip === undefined) {
      return [];
    }
    return parseLog(await this.logText(tip), parseHgNode);
  }

  async appendLog(change: RefName, entries: readonly LogEntry<HgNode>[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const mark = logBookmark(change);
    const old = (await this.bookmarks()).get(mark);
    const log = old === undefined ? "" : await this.logText(old);
    if (log !== "" && !log.endsWith("\n")) {
      throw new Error(`malformed log for ${change}: missing trailing newline`);
    }
    const node = await this.commitLog(change, old, log + entries.map(formatLogEntry).join(""));
    // hg bookmarks have no compare-and-swap; a concurrent append here loses
    // its bookmark position (never its commit — the entries remain in the
    // log branch's history). TODO: retry from the surviving heads if
    // concurrent same-machine appends turn out to matter.
    await hg(this.root, ["bookmark", "-q", "-f", "-r", node, "--", mark]);
  }

  async deleteLog(change: RefName): Promise<void> {
    const mark = logBookmark(change);
    if ((await this.bookmarks()).has(mark)) {
      await hg(this.root, ["bookmark", "-q", "-d", "--", mark]);
    }
    const remote = (await this.remoteBookmarks()).get(mark);
    if (remote !== undefined) {
      await this.pushkeyDelete(mark, remote);
    }
  }

  async wipeReviewState(): Promise<readonly RefName[]> {
    const names = await this.listChanges();
    if (names.length > 0) {
      await hg(this.root, ["bookmark", "-q", "-d", "--", ...names.map((name) => logBookmark(name))]);
    }
    // The worker holds only rebuildable state.
    await rm(join(this.hgDir(), "cabaret"), { recursive: true, force: true });
    return names;
  }

  async wipeOriginLogs(): Promise<readonly RefName[]> {
    const names: RefName[] = [];
    for (const [mark, node] of await this.remoteBookmarks()) {
      if (!mark.startsWith(LOG_BOOKMARK_PREFIX)) {
        continue;
      }
      await this.pushkeyDelete(mark, node);
      names.push(mark.slice(LOG_BOOKMARK_PREFIX.length) as RefName);
    }
    return names.sort();
  }

  /** The path the `default` remote resolves to, failing when none is configured. */
  private async originUrl(): Promise<string> {
    try {
      return (await hg(this.root, ["paths", ORIGIN_PATH])).trimEnd();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) {
        throw new UserError(`no origin: hg path ${JSON.stringify(ORIGIN_PATH)} is not configured`);
      }
      throw error;
    }
  }

  /** Origin's bookmarks, straight from the remote: one listing round trip. */
  private async remoteBookmarks(): Promise<ReadonlyMap<string, string>> {
    const out = await hg(this.root, ["debugpushkey", await this.originUrl(), "bookmarks"]);
    const marks = new Map<string, string>();
    for (const line of out.split("\n")) {
      if (line === "") {
        continue;
      }
      const cut = line.indexOf("\t");
      if (cut === -1) {
        throw new Error(`malformed pushkey listing line: ${JSON.stringify(line)}`);
      }
      marks.set(line.slice(0, cut), line.slice(cut + 1));
    }
    return marks;
  }

  /**
   * Delete origin's bookmark `mark` via the same pushkey call `hg push -B`
   * rides on — the only way to delete a remote bookmark without first
   * deleting a local one. `old` is compare-and-swapped, so a concurrent move
   * fails rather than deleting a position never seen.
   */
  private async pushkeyDelete(mark: string, old: string): Promise<void> {
    const out = await hg(this.root, ["debugpushkey", await this.originUrl(), "bookmarks", mark, old, ""]);
    if (!out.startsWith("True")) {
      throw new Error(`origin refused deleting bookmark ${JSON.stringify(mark)}: moved concurrently?`);
    }
  }

  /**
   * Run a pull/push against origin with remotenames recording what was seen.
   * The origin rides as hg's implied default path; `remoteReading` accepts
   * records under whatever key remotenames files them.
   */
  private async hgRemote(args: readonly string[]): Promise<void> {
    let out: string;
    try {
      out = await hg(this.root, ["--config", "extensions.remotenames=", ...args]);
    } catch (error) {
      // hg push exits 1 for "nothing to push", which for Cabaret means the
      // remote already has everything — success, unless the same run also
      // reported a bookmark it refused to move. Pushes run un-quieted so
      // these markers are visible at all.
      if (
        (error as { code?: unknown }).code === 1 &&
        aborted(error, /no changes found/) &&
        !aborted(error, /diverged bookmark|creates new remote head/)
      ) {
        return;
      }
      throw error;
    }
    if (/not updating diverged bookmark/.test(out)) {
      throw new Error(`origin refused a diverged bookmark: ${out.trim()}`);
    }
  }

  /**
   * Drop the divergent-bookmark copies a pull leaves when local and remote
   * both moved — `name@default`, or `name@N` when hg could not match the
   * source to a path alias; Cabaret resolves divergence itself — explicitly
   * for logs, by refusing for code branches. Only those suffixes are
   * dropped: a real bookmark may contain `@` too.
   */
  private async dropDivergentBookmark(name: string): Promise<boolean> {
    const divergent = [...(await this.bookmarks()).keys()].filter((mark) => {
      if (!mark.startsWith(`${name}@`)) {
        return false;
      }
      const suffix = mark.slice(name.length + 1);
      return suffix === ORIGIN_PATH || /^\d+$/.test(suffix);
    });
    if (divergent.length === 0) {
      return false;
    }
    await hg(this.root, ["bookmark", "-q", "-d", "--", ...divergent]);
    return true;
  }

  async pushBranch(branch: RefName): Promise<void> {
    // The lease: origin may be overwritten exactly as far as it was last
    // seen — the same bargain as git's push --force-with-lease, minus the
    // server-side atomicity hg does not offer. Checked before any push:
    // hg's own `push -B` happily moves a remote bookmark the pusher has
    // never seen whenever the changesets themselves add no head.
    const lease = await this.remoteReading(branch);
    const remote = (await this.remoteBookmarks()).get(branch);
    if (remote !== undefined && remote !== (lease as string | undefined)) {
      throw new UserError(`origin's copy of ${JSON.stringify(branch)} has work this repository never fetched`);
    }
    // --new-branch: the commits may sit on a named branch origin has never
    // seen (hg's own workflows use them for code); a new branch only adds a
    // head, and the bookmark lease above is what guards overwrites.
    try {
      await this.hgRemote(["push", "--new-branch", "-B", branch]);
      return;
    } catch (error) {
      if (!aborted(error, /push creates new remote head|diverged bookmark/)) {
        throw error;
      }
    }
    // The new head replaces work within the lease, checked just above.
    await this.hgRemote(["push", "-f", "-B", branch]);
  }

  async fetchBranch(branch: RefName): Promise<void> {
    const before = await this.branchTip(branch);
    // Read before pulling: a pull that moves the active bookmark deactivates it.
    const active = (await this.activeBookmark()) === branch;
    if (before === undefined) {
      // -B imports the bookmark outright, creating the local branch. -f on
      // every pull: two machines' histories may share nothing at all (log
      // chains are rootless by design), which plain hg refuses to pull across.
      await this.hgRemote(["pull", "-q", "-f", "-B", branch]);
      return;
    }
    // A plain pull of the remote head fast-forwards a matching local
    // bookmark and leaves a divergent copy otherwise — never overwriting.
    try {
      await this.hgRemote(["pull", "-q", "-f", "-r", branch]);
    } catch (error) {
      if (aborted(error, /unknown revision/)) {
        throw new UserError(`origin does not have branch ${JSON.stringify(branch)}`);
      }
      throw error;
    }
    await this.dropDivergentBookmark(branch);
    const remote = await this.remoteReading(branch);
    const after = await this.branchTip(branch);
    if (remote !== undefined && remote !== after) {
      throw new UserError(`branch has diverged from origin: ${JSON.stringify(branch)}`);
    }
    // Carry a checked-out branch's working directory along, as a
    // fast-forward does; hg merges local edits and aborts on overwrite.
    // Updating to the bookmark by name also re-activates it.
    if (after !== before && active) {
      await hg(this.root, ["update", "-q", "--", branch]);
    }
  }

  async fetchBranches(branches: readonly RefName[]): Promise<void> {
    if (branches.length === 0) {
      return;
    }
    // Callers pass only branches absent locally. Best-effort: one branch
    // origin no longer has fails a batched pull wholesale, so fall back to
    // one-by-one and let callers observe what arrived via `branchTip`.
    try {
      await this.hgRemote(["pull", "-q", "-f", ...branches.flatMap((branch) => ["-B", branch])]);
    } catch {
      for (const branch of branches) {
        try {
          await this.hgRemote(["pull", "-q", "-f", "-B", branch]);
        } catch {
          // Observed by the caller as a still-missing branch.
        }
      }
    }
  }

  async syncLog(change: RefName): Promise<void> {
    await this.reconcileLog(change);
  }

  async syncLogs(): Promise<readonly RefName[]> {
    const names = new Set<RefName>(await this.listChanges());
    for (const mark of (await this.remoteBookmarks()).keys()) {
      if (mark.startsWith(LOG_BOOKMARK_PREFIX)) {
        names.add(mark.slice(LOG_BOOKMARK_PREFIX.length) as RefName);
      }
    }
    const changes = [...names].sort();
    for (const changeName of changes) {
      await this.reconcileLog(changeName);
    }
    return changes;
  }

  /**
   * Bring `change`'s local log and origin's to the same content: pull the
   * remote log, merge it with the local one as `mergeLogs` does, and push
   * anything the remote lacks. Losing a race to a concurrent push only means
   * new entries to merge, so re-observe and retry, bounded so a persistent
   * failure surfaces.
   */
  private async reconcileLog(change: RefName): Promise<void> {
    const mark = logBookmark(change);
    for (let attempt = 0; ; attempt++) {
      try {
        try {
          await this.hgRemote(["pull", "-q", "-f", "-r", mark]);
        } catch (error) {
          if (!aborted(error, /unknown revision/)) {
            throw error;
          }
          // Origin has no log for this change yet.
        }
        await this.dropDivergentBookmark(mark);
        const local = (await this.bookmarks()).get(mark);
        const remote = await this.remoteReading(mark);
        let tip = local;
        if (remote !== undefined && remote !== local) {
          tip =
            local === undefined || (await this.isAncestor(local, remote))
              ? remote
              : (await this.isAncestor(remote, local))
                ? local
                : await this.mergeLogCommits(local, remote);
          if (tip !== local) {
            await hg(this.root, ["bookmark", "-q", "-f", "-r", tip, "--", mark]);
          }
        }
        if (tip === undefined || tip === remote) {
          return;
        }
        // Publishing drafts the whole secret chain below the tip; a push
        // then flips it public. --new-branch covers the log branch's first
        // ever push; the bookmark refuses to move over unseen work, which
        // is a retry, never an overwrite.
        try {
          await hg(this.root, ["phase", "--draft", "-r", tip]);
        } catch (error) {
          // Exit code 1 means exactly "no phases changed": the chain is
          // already draft or public, as after a retried push.
          if ((error as { code?: unknown }).code !== 1) {
            throw error;
          }
        }
        await this.hgRemote(["push", "--new-branch", "-B", mark]);
        return;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
      }
    }
  }

  /** The merge of two log commits: `mergeLogs` of their entries, atop both. */
  private async mergeLogCommits(a: HgNode, b: HgNode): Promise<HgNode> {
    const [logA, logB] = await Promise.all([this.logText(a), this.logText(b)]);
    const merged = mergeLogs(parseLog(logA, parseHgNode), parseLog(logB, parseHgNode)).map(formatLogEntry).join("");
    await this.workerReset(a);
    await this.hgWorker(["debugsetparents", a, b]);
    await writeFile(join(await this.worker(), LOG_PATH), merged);
    return this.commitLogState();
  }

  // ---- merges ----

  /**
   * The content merge of `secondary` into `primary`, resolved against
   * `base`: what changed base → secondary, applied atop primary's copy.
   * Computed here — hg's own merge machinery resolves against the DAG
   * ancestor, with no way to name `base` instead, and Cabaret's whole
   * rebase-tolerance rests on resolving against the change's own base.
   */
  private async computeMerge(base: HgNode, primary: HgNode, secondary: HgNode): Promise<readonly MergedFile[]> {
    const merged: MergedFile[] = [];
    for (const path of await this.changedFiles(base, secondary)) {
      const [baseC, primaryC, secondaryC] = await Promise.all([
        this.readFile(base, path),
        this.readFile(primary, path),
        this.readFile(secondary, path),
      ]);
      if (primaryC === baseC || primaryC === secondaryC) {
        // Primary kept the base's copy (or already agrees): take secondary's.
        merged.push({ path, content: secondaryC, conflict: false });
        continue;
      }
      if (secondaryC === undefined || primaryC === undefined) {
        // One side deleted what the other edited: a conflict markers cannot
        // express, so the surviving edit stays in place, flagged.
        merged.push({ path, content: primaryC ?? secondaryC, conflict: true });
        continue;
      }
      const three = mergeDiff3(lines(primaryC), lines(baseC ?? ""), lines(secondaryC), {
        // zdiff3-style markers, labeled by revision like git's merges.
        label: { a: shortHash(primary), o: shortHash(base), b: shortHash(secondary) },
      });
      merged.push({ path, content: three.result.join("\n"), conflict: three.conflict });
    }
    return merged;
  }

  async mergeConflicts(base: HgNode, tip: HgNode, onto: HgNode): Promise<readonly FilePath[]> {
    return (await this.computeMerge(base, tip, onto)).filter(({ conflict }) => conflict).map(({ path }) => path);
  }

  /**
   * Build a commit in the worker: primary checked out, `files` applied, the
   * given parents, carrying `message` under the repository's own identity.
   */
  private async commitMerge(
    primary: HgNode,
    files: readonly MergedFile[],
    parents: readonly [HgNode] | readonly [HgNode, HgNode],
    message: string,
  ): Promise<HgNode> {
    await this.workerReset(primary);
    const dir = await this.worker();
    const written: FilePath[] = [];
    for (const { path, content } of files) {
      const target = join(dir, path);
      if (content === undefined) {
        if (existsSync(target)) {
          await this.hgWorker(["rm", "-q", "-f", `path:${path}`]);
        }
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      written.push(path);
    }
    if (written.length > 0) {
      // Adding a tracked file is a no-op, so every written path can be added.
      await this.hgWorker(["add", "-q", ...written.map((path) => `path:${path}`)]);
    }
    const second = parents[1];
    if (second !== undefined) {
      await this.hgWorker(["debugsetparents", parents[0], second]);
    }
    const username = await this.config("ui.username");
    await this.hgWorker([
      "commit",
      "-q",
      // A net-empty change still lands as a commit, as git's commit-tree
      // would write it; without this a squash of one aborts "nothing changed".
      "--config",
      "ui.allowemptycommit=yes",
      ...(username === undefined ? [] : ["--config", `ui.username=${username}`]),
      "-m",
      message,
    ]);
    return this.workerNode();
  }

  /**
   * Advance `branch` from `expected` to descendant `commit`, failing fast on
   * a concurrent move; a checked-out branch's working directory follows.
   */
  private async advanceBranch(branch: RefName, commit: HgNode, expected: HgNode): Promise<void> {
    if ((await this.branchTip(branch)) !== expected) {
      throw new Error(`branch moved concurrently: ${JSON.stringify(branch)}`);
    }
    await hg(this.root, ["bookmark", "-q", "-f", "-r", commit, "--", branch]);
    if ((await this.activeBookmark()) === branch) {
      await hg(this.root, ["update", "-q", "--", branch]);
    }
  }

  async merge(into: RefName, base: HgNode, onto: HgNode, tip: HgNode, message: string): Promise<HgNode> {
    return this.commitLand(into, base, onto, tip, message, [onto, tip]);
  }

  async squash(into: RefName, base: HgNode, onto: HgNode, tip: HgNode, message: string): Promise<HgNode> {
    return this.commitLand(into, base, onto, tip, message, [onto]);
  }

  private async commitLand(
    into: RefName,
    base: HgNode,
    onto: HgNode,
    tip: HgNode,
    message: string,
    parents: readonly [HgNode] | readonly [HgNode, HgNode],
  ): Promise<HgNode> {
    const files = await this.computeMerge(base, onto, tip);
    const conflicted = files.filter(({ conflict }) => conflict).map(({ path }) => path);
    if (conflicted.length > 0) {
      throw new Error(`landing ${tip} onto ${onto} conflicts in ${conflicted.join(", ")}`);
    }
    const commit = await this.commitMerge(onto, files, parents, message);
    await this.advanceBranch(into, commit, onto);
    return commit;
  }

  async mergeOnto(change: RefName, base: HgNode, onto: HgNode, message: string): Promise<readonly FilePath[]> {
    const tip = (await this.bookmarks()).get(change);
    if (tip === undefined) {
      throw new UserError(`branch does not exist: ${JSON.stringify(change)}`);
    }
    if (await this.isAncestor(tip, onto)) {
      await this.advanceBranch(change, onto, tip);
      return [];
    }
    const files = await this.computeMerge(base, tip, onto);
    const commit = await this.commitMerge(tip, files, [tip, onto], message);
    await this.advanceBranch(change, commit, tip);
    return files.filter(({ conflict }) => conflict).map(({ path }) => path);
  }
}
