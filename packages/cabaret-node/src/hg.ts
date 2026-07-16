import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile as readFsFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type ChangeName,
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
  type Revision,
  shortHash,
  UserError,
  type UserName,
  userName,
  VcsUnavailableError,
  type Workspace,
} from "cabaret-core";

const execFileAsync = promisify(execFile);

const HG_NODE = /^[0-9a-f]{40}$/;

/** The all-zeros id of hg's null revision: what revset functions yield for "no revision". */
const NULL_NODE = "0".repeat(40);

/** Parse a full (non-abbreviated) Mercurial changeset id: the hg backend's `parseRevision`. */
export function parseHgNode(raw: string): Revision {
  if (!HG_NODE.test(raw) || raw === NULL_NODE) {
    throw new Error(`not an hg changeset id: ${JSON.stringify(raw)}`);
  }
  return raw as Revision;
}

// hg's own label rules forbid `:`, control characters, the reserved names
// `tip`, `null`, and `.`, and whole names of digits alone, which read as
// revision numbers. Cabaret adds its own reservations: `@`, because hg names
// divergent bookmark copies `name@suffix` and Cabaret must tell those from
// real bookmarks; the `cabaret/` prefix, where log bookmarks live (bookmarks
// are one flat namespace); and surrounding whitespace, which hg strips on
// input so such a name could never round-trip.
// biome-ignore lint/suspicious/noControlCharactersInRegex: hg label names forbid control characters, so we must match them.
const HG_NAME_FORBIDDEN = /[\x00-\x1f\x7f:@]|^(?:tip|null|\.|[0-9]+)$|^cabaret\/|^\s|\s$/;

/** Parse an hg bookmark name: the hg backend's `parseName`. */
export function parseHgName(raw: string): ChangeName {
  if (raw === "" || HG_NAME_FORBIDDEN.test(raw)) {
    throw new UserError(`not a valid bookmark name: ${JSON.stringify(raw)}`);
  }
  return raw as ChangeName;
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
 * Run hg in `cwd` with no configuration of Cabaret's own and return its
 * stdout. HGPLAIN keeps the output stable against user aliases,
 * localization, and tweaked defaults; on nonzero exit the rejection already
 * names the command and carries stderr in its message. Config readings go
 * through here: `hg`'s injected extension would shadow the user's real
 * configuration for its own key.
 */
async function hgRaw(cwd: string, args: readonly string[]): Promise<string> {
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

/**
 * As `hgRaw`, with the bundled share extension riding along: without it, hg
 * cannot create shares, and inside a share made with -B it cannot see the
 * shared bookmark store at all.
 */
async function hg(cwd: string, args: readonly string[]): Promise<string> {
  return hgRaw(cwd, ["--config", "extensions.share=", ...args]);
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
 * Where logs live: one chain of commits rooted at hg's null revision, so it
 * shares no history with the code, whose tree holds one file per change
 * under `LOGS_DIR`. The `LOG_BOOKMARK` bookmark is the movable pointer to
 * the chain's tip — the single entry Cabaret adds to the user's bookmark
 * list. The chain carries the `LOG_BRANCH` named branch (hg forbids a
 * bookmark shadowing a branch name, so the two differ), and every commit
 * after the chain's root closes the branch, keeping it out of `hg branches`
 * and `hg heads` — hg refuses to close a branch on its root commit, so the
 * root is followed at once by an empty closing child. Log commits stay in
 * the secret phase until a sync publishes them, so the user's own `hg push`
 * never trips over them.
 */
const LOG_BOOKMARK = "cabaret/log";

/** The named branch of the log chain's commits. */
const LOG_BRANCH = "cabaret/logs";

/** The tree directory holding one log file per change. */
const LOGS_DIR = "logs";

/**
 * The tree path of `change`'s log: its name flattened under `LOGS_DIR`, with
 * `%`, `/`, and `\` percent-escaped so a name nesting another ("x", "x/y")
 * cannot collide as file against directory, and no separator reaches the
 * filesystem. `decodeLogName` inverts it.
 */
function logPath(change: ChangeName): FilePath {
  const flat = change.replace(/[%/\\]/g, (ch) => (ch === "%" ? "%25" : ch === "/" ? "%2F" : "%5C"));
  return parseFilePath(`${LOGS_DIR}/${flat}`);
}

/** The change name of a log tree path, inverting `logPath`. */
function decodeLogName(path: string): ChangeName {
  const flat = path.slice(LOGS_DIR.length + 1);
  return parseHgName(flat.replace(/%(25|2F|5C)/g, (token) => (token === "%25" ? "%" : token === "%2F" ? "/" : "\\")));
}

/** The remote every remote operation uses: hg's counterpart of git's `origin`. */
const ORIGIN_PATH = "default";

/** hg's marker-writing internal merge tools: what a headless merge can honor from the user's `ui.merge`. */
const MARKER_STYLES = ["merge", "merge3", "mergediff"];

/**
 * The root of the repository `root`'s working tree belongs to: `root` itself
 * normally, or the source a share's `.hg/sharedpath` names.
 */
async function sourceRoot(root: string): Promise<string> {
  let shared: string;
  try {
    shared = (await readFsFile(join(root, ".hg", "sharedpath"), "utf8")).trimEnd();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return root;
    }
    throw error;
  }
  // A relative sharedpath (hg's relshared) resolves against the share's .hg.
  return dirname(isAbsolute(shared) ? shared : join(root, ".hg", shared));
}

/** A `Backend` that shells out to a local `hg` (Mercurial). */
export class HgBackend implements Backend {
  readonly vcs = "hg";

  readonly parseRevision = parseHgNode;

  readonly parseName = parseHgName;

  private constructor(
    readonly root: string,
    /**
     * Root of the repository the working tree belongs to: `root` itself in
     * the primary, the share's source in a dedicated workspace. Config, logs,
     * the worker, and every remote exchange live here, so all workspaces of
     * one repository read and write the same state.
     */
    private readonly repoRoot: string,
    /** Repo-relative path of the directory the backend was opened from: "" at the root, "src/" below it. */
    private readonly prefix: string,
  ) {}

  /** Open the hg repository containing `dir`. */
  static async open(dir: string): Promise<HgBackend> {
    const root = (await hg(dir, ["root"])).trimEnd();
    // hg has no `--show-prefix`; resolving both paths keeps symlinked
    // spellings of the same directory from producing a bogus prefix.
    const prefix = relative(await realpath(root), await realpath(dir));
    return new HgBackend(root, await sourceRoot(root), prefix === "" ? "" : `${prefix}${sep}`);
  }

  private hgDir(): string {
    return join(this.repoRoot, ".hg");
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

  /**
   * The active bookmark, or undefined when none is active — hg's detached
   * HEAD. A bookmark made outside Cabaret whose name Cabaret's grammar
   * reserves cannot be a change, so it also reads as none active.
   */
  private async activeBookmark(workspace: string = this.root): Promise<ChangeName | undefined> {
    const out = await hg(workspace, ["log", "-r", "wdir()", "-T", "{activebookmark}"]);
    if (out === "") {
      return undefined;
    }
    try {
      return parseHgName(out);
    } catch {
      return undefined;
    }
  }

  async currentChange(): Promise<ChangeName> {
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
      // Raw, so the reading reflects the user's real configuration, and in
      // the source repository: a share's own .hg/hgrc is never written, so
      // every workspace reads the same settings.
      const out = await hgRaw(this.repoRoot, ["config", key]);
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
      {
        key: "extensions.share",
        value: "",
        scope: "global",
        multi: false,
        brief: "sharing working trees, so your own hg sees every change in a dedicated workspace",
      },
      {
        key: "ui.merge",
        value: ":merge3",
        scope: "global",
        multi: false,
        brief: "merge3 conflict markers, so conflicts show the base",
      },
    ];
  }

  async resolveCommit(expression: string): Promise<Revision> {
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
  private async bookmarks(): Promise<ReadonlyMap<string, Revision>> {
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
    const marks = new Map<string, Revision>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      marks.set(fields[i] as string, parseHgNode(fields[i + 1] as string));
    }
    return marks;
  }

  async tip(change: ChangeName): Promise<Revision | undefined> {
    return (await this.bookmarks()).get(change);
  }

  async originTip(change: ChangeName): Promise<Revision | undefined> {
    return this.remoteReading(change);
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
  private async remoteReading(bookmark: string): Promise<Revision | undefined> {
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

  async create(name: ChangeName, commit: Revision): Promise<void> {
    // `hg bookmark` moves an existing bookmark rather than failing, and hg
    // has no compare-and-swap for them, so existence is checked first; the
    // remaining race loses no commits, only a bookmark position.
    if ((await this.tip(name)) !== undefined) {
      throw new UserError(`bookmark already exists: ${JSON.stringify(name)}`);
    }
    await hg(this.root, ["bookmark", "-r", commit, "--", name]);
  }

  /** Where the workspace registry lives: hg keeps no record of a repository's shares, so Cabaret keeps its own. */
  private registryFile(): string {
    return join(this.hgDir(), "cabaret", "workspaces");
  }

  /** The registered dedicated-workspace paths, in registration order. */
  private async registeredWorkspaces(): Promise<readonly string[]> {
    try {
      return (await readFsFile(this.registryFile(), "utf8")).split("\n").filter((line) => line !== "");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeRegistry(paths: readonly string[]): Promise<void> {
    await mkdir(dirname(this.registryFile()), { recursive: true });
    await writeFile(this.registryFile(), paths.map((path) => `${path}\n`).join(""));
  }

  /** One workspace's reading, or undefined for a registry entry that is no longer a share of this repository. */
  private async readWorkspace(path: string, primary: boolean): Promise<Workspace | undefined> {
    const source = primary
      ? undefined
      : await sourceRoot(path)
          .then(realpath)
          .catch((error) => {
            // Only a vanished directory reads as "no longer a workspace";
            // anything else is a real failure.
            if ((error as { code?: unknown }).code !== "ENOENT") {
              throw error;
            }
            return undefined;
          });
    if (!primary && source !== (await realpath(this.repoRoot))) {
      return undefined;
    }
    const [change, status] = await Promise.all([this.activeBookmark(path), hg(path, ["status"])]);
    return { path, change, dirty: status !== "", primary };
  }

  async workspaces(): Promise<readonly Workspace[]> {
    const registered = await this.registeredWorkspaces();
    const read = await Promise.all([
      this.readWorkspace(this.repoRoot, true),
      ...registered.map((path) => this.readWorkspace(path, false)),
    ]);
    const found = read.filter((workspace) => workspace !== undefined);
    // A workspace whose directory is gone is not a working tree anymore;
    // prune it from the registry as well as the listing.
    if (found.length !== read.length) {
      await this.writeRegistry(found.filter(({ primary }) => !primary).map(({ path }) => path));
    }
    return found;
  }

  /**
   * Fail unless the user's own hg would see the shared bookmark store. The
   * backend enables the share extension itself on every call, but inside a
   * share the user's plain hg shows no bookmarks and commits without moving
   * the change's, so a workspace without the config is a trap, not a tree.
   */
  private async assertShareConfigured(): Promise<void> {
    const value = await this.config("extensions.share");
    // A "!" prefix is hg's spelling for an explicitly disabled extension.
    if (value === undefined || value.startsWith("!")) {
      throw new UserError(
        "dedicated workspaces need the share extension enabled for your own hg: run `cabaret setup apply`",
      );
    }
  }

  async addWorkspace(path: string, change: ChangeName): Promise<void> {
    await this.assertShareConfigured();
    // -B shares the bookmark store, so every workspace names the same
    // changes; each keeps its own active bookmark and working directory.
    // -U so the only checkout is the change's, below.
    await hg(this.repoRoot, ["share", "-q", "-U", "-B", this.repoRoot, path]);
    await hg(path, ["update", "-q", "--", change]);
    await this.writeRegistry([...(await this.registeredWorkspaces()), await realpath(path)]);
  }

  async removeWorkspace(path: string, force: boolean): Promise<void> {
    const resolved = await realpath(path);
    const registered = await this.registeredWorkspaces();
    if (!registered.includes(resolved)) {
      throw new UserError(`not a dedicated workspace: ${path}`);
    }
    if (!force && (await hg(resolved, ["status"])) !== "") {
      throw new UserError(`workspace has uncommitted changes: ${path}`);
    }
    await rm(resolved, { recursive: true, force: true });
    await this.writeRegistry(registered.filter((entry) => entry !== resolved));
  }

  async checkout(change: ChangeName): Promise<void> {
    if ((await this.tip(change)) === undefined) {
      throw new UserError(`bookmark does not exist: ${JSON.stringify(change)}`);
    }
    // Updating to a bookmark by name activates it; local edits merge along,
    // and hg aborts when one would be overwritten. Two workspaces may hold
    // the same change — unlike git, hg tolerates it: a commit only advances
    // a bookmark sitting on the new commit's parent, so the slower
    // workspace just grows an anonymous head to resolve, never corruption.
    await hg(this.root, ["update", "-q", "--", change]);
  }

  async rename(from: ChangeName, to: ChangeName): Promise<void> {
    if ((await this.tip(from)) === undefined) {
      throw new UserError(`bookmark does not exist: ${JSON.stringify(from)}`);
    }
    const logs = await this.logsTip();
    const log = logs === undefined ? undefined : await this.readFile(logs, logPath(from));
    if (logs === undefined || log === undefined) {
      throw new Error(`change has no log: ${JSON.stringify(from)}`);
    }
    if ((await this.bookmarks()).has(to) || (await this.readFile(logs, logPath(to))) !== undefined) {
      throw new UserError(`bookmark or log already exists: ${JSON.stringify(to)}`);
    }
    // Two steps, not one transaction: a crash between them strands the
    // change under two names — visibly, and mendable by renaming the code
    // bookmark by hand.
    const node = await this.commitLogTree(logs, [
      { path: logPath(from), content: undefined },
      { path: logPath(to), content: log },
    ]);
    await this.moveLogsTip(node);
    // `bookmark -m` rejects a "--" separator outright, so the names ride bare.
    await hg(this.root, ["bookmark", "-m", from, to]);
  }

  /** The single node `revset` names, or undefined when it names none. */
  private async revsetNode(revset: string): Promise<Revision | undefined> {
    const out = await hg(this.root, ["log", "-r", revset, "-T", "{node}\n"]);
    const node = out.split("\n").find((line) => line !== "");
    return node === undefined || node === NULL_NODE ? undefined : parseHgNode(node);
  }

  async mergeBase(a: Revision, b: Revision): Promise<Revision> {
    const found = await this.revsetNode(`ancestor(${a}, ${b})`);
    if (found === undefined) {
      throw new Error(`no common ancestor of ${a} and ${b}`);
    }
    return found;
  }

  async isAncestor(ancestor: Revision, descendant: Revision): Promise<boolean> {
    return (await this.revsetNode(`ancestor(${ancestor}, ${descendant})`)) === ancestor;
  }

  async mergedTip(merge: Revision): Promise<Revision> {
    const out = await hg(this.root, ["log", "-r", merge, "-T", "{p2node}"]);
    if (out === NULL_NODE) {
      throw new Error(`not a merge commit: ${merge}`);
    }
    return parseHgNode(out);
  }

  async readFile(commit: Revision, file: FilePath): Promise<string | undefined> {
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

  async changedFiles(base: Revision, tip: Revision): Promise<readonly FilePath[]> {
    // hg reports a move as a remove plus an add unless asked to trace
    // copies, so each path names the same file on both sides. Subrepo state
    // files (.hgsub*) are ordinary files and stay listed.
    const out = await hg(this.root, ["status", "--rev", base, "--rev", tip, "-T", "{path}\\0"]);
    return out
      .split("\0")
      .filter((path) => path !== "")
      .map(parseFilePath);
  }

  async landMerges(base: Revision, tip: Revision): Promise<readonly LandMerge[]> {
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
    const merges: LandMerge[] = [];
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
      await hg(this.repoRoot, ["share", "-q", "-U", this.repoRoot, dir]);
    }
    return dir;
  }

  /** Run hg in the worker. */
  private async hgWorker(args: readonly string[]): Promise<string> {
    return hg(await this.worker(), args);
  }

  /** Reset the worker's working directory to `node` (or empty, for the null revision), clearing strays from failed runs. */
  private async workerReset(node: Revision | "null"): Promise<void> {
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
  private async workerNode(): Promise<Revision> {
    return parseHgNode((await this.hgWorker(["log", "-r", ".", "-T", "{node}"])).trimEnd());
  }

  /**
   * Commit the worker's working directory as a log commit: secret until a
   * sync publishes it, and closing the log branch — except on a chain's
   * root, where hg has no head to close yet — so the branch never surfaces
   * in `hg branches` or `hg heads`.
   */
  private async commitLogState(close: boolean): Promise<Revision> {
    await this.hgWorker([
      "commit",
      "-q",
      ...(close ? ["--close-branch"] : []),
      "--config",
      "phases.new-commit=secret",
      "--config",
      // The chain-closing child after a fresh root carries no file changes.
      "ui.allowemptycommit=yes",
      "--config",
      // Log commits are bookkeeping; the entries inside carry the real identities.
      "ui.username=cabaret",
      "-m",
      "cabaret log",
    ]);
    return this.workerNode();
  }

  /**
   * Apply `writes` to the log tree in the worker atop `parent` — a fresh
   * chain root when undefined — and commit; an undefined content removes
   * the file.
   */
  private async commitLogTree(
    parent: Revision | undefined,
    writes: readonly { readonly path: FilePath; readonly content: string | undefined }[],
  ): Promise<Revision> {
    if (parent === undefined) {
      await this.workerReset("null");
      // -f: the branch label outlives a wiped chain; a fresh root reuses it.
      await this.hgWorker(["branch", "-q", "-f", LOG_BRANCH]);
    } else {
      await this.workerReset(parent);
    }
    const dir = await this.worker();
    const written: FilePath[] = [];
    for (const { path, content } of writes) {
      if (content === undefined) {
        await this.hgWorker(["rm", "-q", "-f", `path:${path}`]);
        continue;
      }
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
      written.push(path);
    }
    if (written.length > 0) {
      await this.hgWorker(["add", "-q", ...written.map((path) => `path:${path}`)]);
    }
    if (parent !== undefined) {
      return this.commitLogState(true);
    }
    // hg cannot close a branch on its root commit, so a fresh chain's root
    // is followed at once by an empty closing child, keeping the branch out
    // of `hg branches` from its first state on.
    await this.commitLogState(false);
    return this.commitLogState(true);
  }

  // ---- logs ----

  /** The tip of the log chain, or undefined when this repository has no logs. */
  private async logsTip(): Promise<Revision | undefined> {
    return (await this.bookmarks()).get(LOG_BOOKMARK);
  }

  /** Move the log bookmark to `node`. hg bookmarks have no compare-and-swap; a concurrent move here loses its position (never its commit — every state remains in the chain's history). TODO: retry from the surviving heads if concurrent same-machine appends turn out to matter. */
  private async moveLogsTip(node: Revision): Promise<void> {
    await hg(this.root, ["bookmark", "-q", "-f", "-r", node, "--", LOG_BOOKMARK]);
  }

  /** The log tree paths at `node`, one per change. */
  private async logFiles(node: Revision): Promise<readonly FilePath[]> {
    let out: string;
    try {
      out = await hg(this.root, ["files", "-r", node, "-T", "{path}\\0", `path:${LOGS_DIR}`]);
    } catch (error) {
      // Exit code 1 means exactly "no matches": a tree holding no logs.
      if ((error as { code?: unknown }).code === 1) {
        return [];
      }
      throw error;
    }
    return out
      .split("\0")
      .filter((path) => path !== "")
      .map(parseFilePath);
  }

  async listChanges(): Promise<readonly ChangeName[]> {
    const logs = await this.logsTip();
    if (logs === undefined) {
      return [];
    }
    return (await this.logFiles(logs)).map((path) => decodeLogName(path)).sort();
  }

  async readLog(change: ChangeName): Promise<readonly LogEntry[]> {
    const logs = await this.logsTip();
    const text = logs === undefined ? undefined : await this.readFile(logs, logPath(change));
    if (text === undefined) {
      return [];
    }
    return parseLog(text, parseHgNode, parseHgName);
  }

  async appendLog(change: ChangeName, entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const logs = await this.logsTip();
    const log = logs === undefined ? undefined : await this.readFile(logs, logPath(change));
    if (log !== undefined && log !== "" && !log.endsWith("\n")) {
      throw new Error(`malformed log for ${change}: missing trailing newline`);
    }
    const text = (log ?? "") + entries.map(formatLogEntry).join("");
    await this.moveLogsTip(await this.commitLogTree(logs, [{ path: logPath(change), content: text }]));
  }

  async deleteLog(change: ChangeName): Promise<void> {
    // Deletion is one more log state: pull and merge first so the removal
    // lands atop everything origin holds, then push, deleting origin's copy
    // too. A machine still holding the log resurrects it at its next sync —
    // callers decide a log holds nothing worth keeping before deleting it.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pullLogs();
        const logs = await this.logsTip();
        if (logs !== undefined && (await this.readFile(logs, logPath(change))) !== undefined) {
          await this.moveLogsTip(await this.commitLogTree(logs, [{ path: logPath(change), content: undefined }]));
        }
        await this.pushLogs();
        return;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
      }
    }
  }

  async wipeReviewState(): Promise<readonly ChangeName[]> {
    const names = await this.listChanges();
    if ((await this.logsTip()) !== undefined) {
      await hg(this.root, ["bookmark", "-q", "-d", "--", LOG_BOOKMARK]);
    }
    // The worker holds only rebuildable state; the workspace registry
    // beside it survives a wipe.
    await rm(join(this.hgDir(), "cabaret", "worker"), { recursive: true, force: true });
    return names;
  }

  async wipeOriginLogs(): Promise<readonly ChangeName[]> {
    const remote = (await this.remoteBookmarks()).get(LOG_BOOKMARK);
    if (remote === undefined) {
      return [];
    }
    // Pull the remote tip first, to name what is being deleted.
    await this.hgRemote(["pull", "-q", "-f", "-r", remote]);
    const names = (await this.logFiles(parseHgNode(remote))).map((path) => decodeLogName(path)).sort();
    await this.pushkeyDelete(LOG_BOOKMARK, remote);
    return names;
  }

  /** The path the `default` remote resolves to, failing when none is configured. */
  private async originUrl(): Promise<string> {
    try {
      return (await hg(this.repoRoot, ["paths", ORIGIN_PATH])).trimEnd();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) {
        throw new UserError(`no origin: hg path ${JSON.stringify(ORIGIN_PATH)} is not configured`);
      }
      throw error;
    }
  }

  /** Origin's bookmarks, straight from the remote: one listing round trip. */
  private async remoteBookmarks(): Promise<ReadonlyMap<string, string>> {
    const out = await hg(this.repoRoot, ["debugpushkey", await this.originUrl(), "bookmarks"]);
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
    const out = await hg(this.repoRoot, ["debugpushkey", await this.originUrl(), "bookmarks", mark, old, ""]);
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
      out = await hg(this.repoRoot, ["--config", "extensions.remotenames=", ...args]);
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

  async push(change: ChangeName): Promise<void> {
    // The lease: origin may be overwritten exactly as far as it was last
    // seen — the same bargain as git's push --force-with-lease, minus the
    // server-side atomicity hg does not offer. Checked before any push:
    // hg's own `push -B` happily moves a remote bookmark the pusher has
    // never seen whenever the changesets themselves add no head.
    const lease = await this.remoteReading(change);
    const remote = (await this.remoteBookmarks()).get(change);
    if (remote !== undefined && remote !== (lease as string | undefined)) {
      throw new UserError(`origin's copy of ${JSON.stringify(change)} has work this repository never fetched`);
    }
    // --new-branch: the commits may sit on a named branch origin has never
    // seen (hg's own workflows use them for code); a new branch only adds a
    // head, and the bookmark lease above is what guards overwrites.
    try {
      await this.hgRemote(["push", "--new-branch", "-B", change]);
      return;
    } catch (error) {
      if (!aborted(error, /push creates new remote head|diverged bookmark/)) {
        throw error;
      }
    }
    // The new head replaces work within the lease, checked just above.
    await this.hgRemote(["push", "-f", "-B", change]);
  }

  async fetch(change: ChangeName): Promise<void> {
    const before = await this.tip(change);
    // Read before pulling: a pull that moves the active bookmark deactivates it.
    const active = (await this.activeBookmark()) === change;
    if (before === undefined) {
      // -B imports the bookmark outright, creating the local change. -f on
      // every pull: two machines' histories may share nothing at all (log
      // chains are rootless by design), which plain hg refuses to pull across.
      await this.hgRemote(["pull", "-q", "-f", "-B", change]);
      return;
    }
    // A plain pull of the remote head fast-forwards a matching local
    // bookmark and leaves a divergent copy otherwise — never overwriting.
    try {
      await this.hgRemote(["pull", "-q", "-f", "-r", change]);
    } catch (error) {
      if (aborted(error, /unknown revision/)) {
        throw new UserError(`origin does not have bookmark ${JSON.stringify(change)}`);
      }
      throw error;
    }
    await this.dropDivergentBookmark(change);
    const remote = await this.remoteReading(change);
    const after = await this.tip(change);
    if (remote !== undefined && remote !== after) {
      throw new UserError(`bookmark has diverged from origin: ${JSON.stringify(change)}`);
    }
    // Carry a checked-out change's working directory along, as a
    // fast-forward does; hg merges local edits and aborts on overwrite.
    // Updating to the bookmark by name also re-activates it.
    if (after !== before && active) {
      await hg(this.root, ["update", "-q", "--", change]);
    }
  }

  async fetchAll(changes: readonly ChangeName[]): Promise<void> {
    if (changes.length === 0) {
      return;
    }
    // Callers pass only changes absent locally. Best-effort: one change
    // origin no longer has fails a batched pull wholesale, so fall back to
    // one-by-one and let callers observe what arrived via `tip`.
    try {
      await this.hgRemote(["pull", "-q", "-f", ...changes.flatMap((change) => ["-B", change])]);
    } catch {
      for (const change of changes) {
        try {
          await this.hgRemote(["pull", "-q", "-f", "-B", change]);
        } catch {
          // Observed by the caller as a still-missing change.
        }
      }
    }
  }

  async syncLog(_change: ChangeName): Promise<void> {
    // The chain is one unit: syncing one change's log syncs them all.
    await this.reconcileLogs();
  }

  async syncLogs(): Promise<readonly ChangeName[]> {
    await this.reconcileLogs();
    return this.listChanges();
  }

  /**
   * Bring the local log chain and origin's to the same content: pull the
   * remote chain, merge it with the local one as `mergeLogs` does, and push
   * anything the remote lacks. Losing a race to a concurrent push only means
   * new entries to merge, so re-observe and retry, bounded so a persistent
   * failure surfaces.
   */
  private async reconcileLogs(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pullLogs();
        await this.pushLogs();
        return;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
      }
    }
  }

  /** Pull origin's log chain and merge it into the local one, without pushing. */
  private async pullLogs(): Promise<void> {
    try {
      await this.hgRemote(["pull", "-q", "-f", "-r", LOG_BOOKMARK]);
    } catch (error) {
      if (!aborted(error, /unknown revision/)) {
        throw error;
      }
      // Origin has no logs yet.
    }
    await this.dropDivergentBookmark(LOG_BOOKMARK);
    const local = await this.logsTip();
    const remote = await this.remoteReading(LOG_BOOKMARK);
    if (remote === undefined || remote === local) {
      return;
    }
    const tip =
      local === undefined || (await this.isAncestor(local, remote))
        ? remote
        : (await this.isAncestor(remote, local))
          ? local
          : await this.mergeLogChains(local, remote);
    if (tip !== local) {
      await this.moveLogsTip(tip);
    }
  }

  /** Push the local log chain to origin. */
  private async pushLogs(): Promise<void> {
    const tip = await this.logsTip();
    if (tip === undefined) {
      return;
    }
    // Unconditionally: a push with nothing to send is a cheap no-op, while
    // skipping on the last-exchanged record goes wrong once origin's
    // bookmark was deleted out from under it (wipeOriginLogs), which the
    // stale record would hide forever.
    // Publishing drafts the whole secret chain below the tip; a push then
    // flips it public. --new-branch covers the log branch's first ever push;
    // the bookmark refuses to move over unseen work, which is a retry, never
    // an overwrite.
    try {
      await hg(this.root, ["phase", "--draft", "-r", tip]);
    } catch (error) {
      // Exit code 1 means exactly "no phases changed": the chain is already
      // draft or public, as after a retried push.
      if ((error as { code?: unknown }).code !== 1) {
        throw error;
      }
    }
    await this.hgRemote(["push", "--new-branch", "-B", LOG_BOOKMARK]);
  }

  /**
   * The merge of two log chain states: file-wise union of their trees, with
   * a log both sides hold merged as `mergeLogs` does. A file one side lacks
   * is kept — so a deletion loses to a concurrent append, never the reverse.
   */
  private async mergeLogChains(a: Revision, b: Revision): Promise<Revision> {
    const [filesA, filesB] = await Promise.all([this.logFiles(a), this.logFiles(b)]);
    const paths = [...new Set([...filesA, ...filesB])].sort();
    const writes: { path: FilePath; content: string }[] = [];
    for (const path of paths) {
      const [textA, textB] = await Promise.all([this.readFile(a, path), this.readFile(b, path)]);
      const content =
        textA !== undefined && textB !== undefined
          ? mergeLogs(parseLog(textA, parseHgNode, parseHgName), parseLog(textB, parseHgNode, parseHgName))
              .map(formatLogEntry)
              .join("")
          : // biome-ignore lint/style/noNonNullAssertion: every path came from one of the two trees.
            (textA ?? textB)!;
      writes.push({ path, content });
    }
    await this.workerReset(a);
    await this.hgWorker(["debugsetparents", a, b]);
    const dir = await this.worker();
    const added: FilePath[] = [];
    for (const { path, content } of writes) {
      if ((await this.readFile(a, path)) === content) {
        continue;
      }
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
      added.push(path);
    }
    if (added.length > 0) {
      await this.hgWorker(["add", "-q", ...added.map((path) => `path:${path}`)]);
    }
    return this.commitLogState(true);
  }

  // ---- merges ----

  /**
   * Fail unless `base` is what hg will resolve a merge of `a` and `b`
   * against. Cabaret merges resolve against the change's recorded base, and
   * hg merges against the graph's common ancestor with no way to name
   * another revision — so the two must agree, and the merge is refused when
   * they do not (after a reparent off an unlanded parent, or under a
   * squash-landed one) rather than silently misreading the reviewed diff.
   */
  private async assertMergeableBase(base: Revision, a: Revision, b: Revision): Promise<void> {
    const ancestor = await this.mergeBase(a, b);
    if (ancestor !== base) {
      throw new UserError(
        `the log records base ${shortHash(base)}, but hg merges against the common ancestor ` +
          `${shortHash(ancestor)} and cannot be told otherwise; refusing a merge that would ` +
          `misread the reviewed diff`,
      );
    }
  }

  /**
   * The marker style the user's `ui.merge` names, when it names one of hg's
   * marker-writing internal tools, and merge3 — markers showing the base —
   * otherwise. Merges run headless in the worker and commit their conflicts,
   * so an interactive or auto-resolving tool cannot be honored, only a
   * style.
   */
  private async markerStyle(): Promise<string> {
    const tool = (await this.config("ui.merge"))?.replace(/^(internal)?:/, "");
    return tool !== undefined && MARKER_STYLES.includes(tool) ? tool : "merge3";
  }

  /**
   * hg's own merge of `other` into `primary` in the worker's working
   * directory, returning the conflicted paths. Conflicts stay in the files
   * as markers, every path marked resolved: the markers are the resolution,
   * for the owner to amend in their own time.
   */
  private async workerMerge(primary: Revision, other: Revision): Promise<readonly FilePath[]> {
    await this.workerReset(primary);
    try {
      await this.hgWorker(["merge", "-q", "-r", other, "-t", `:${await this.markerStyle()}`]);
    } catch (error) {
      // Exit code 1 means exactly "unresolved files remain": the merge is
      // done, markers in place. Anything else is a real failure.
      if ((error as { code?: unknown }).code !== 1) {
        throw error;
      }
    }
    const conflicted = (await this.hgWorker(["resolve", "-l"]))
      .split("\n")
      .filter((line) => line.startsWith("U "))
      .map((line) => parseFilePath(line.slice(2)));
    if (conflicted.length > 0) {
      await this.hgWorker(["resolve", "-q", "-m", "--all"]);
    }
    return conflicted;
  }

  async mergeConflicts(base: Revision, tip: Revision, onto: Revision): Promise<readonly FilePath[]> {
    await this.assertMergeableBase(base, tip, onto);
    return this.workerMerge(tip, onto);
  }

  /** Commit the worker's working directory under the repository's own identity and return the new commit. */
  private async workerCommit(message: string): Promise<Revision> {
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
  private async advanceBranch(branch: ChangeName, commit: Revision, expected: Revision): Promise<void> {
    if ((await this.tip(branch)) !== expected) {
      throw new Error(`bookmark moved concurrently: ${JSON.stringify(branch)}`);
    }
    await hg(this.root, ["bookmark", "-q", "-f", "-r", commit, "--", branch]);
    if ((await this.activeBookmark()) === branch) {
      await hg(this.root, ["update", "-q", "--", branch]);
    }
  }

  async merge(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision> {
    return this.commitLand(into, base, onto, tip, message, [onto, tip]);
  }

  async squash(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision> {
    return this.commitLand(into, base, onto, tip, message, [onto]);
  }

  private async commitLand(
    into: ChangeName,
    base: Revision,
    onto: Revision,
    tip: Revision,
    message: string,
    parents: readonly [Revision] | readonly [Revision, Revision],
  ): Promise<Revision> {
    if (onto === base) {
      // The tree is tip's own: nothing to merge, only parents to set.
      await this.workerReset(tip);
    } else {
      await this.assertMergeableBase(base, onto, tip);
      const conflicted = await this.workerMerge(onto, tip);
      if (conflicted.length > 0) {
        throw new Error(`landing ${tip} onto ${onto} conflicts in ${conflicted.join(", ")}`);
      }
    }
    await this.hgWorker(["debugsetparents", ...parents]);
    const commit = await this.workerCommit(message);
    await this.advanceBranch(into, commit, onto);
    return commit;
  }

  async mergeOnto(change: ChangeName, base: Revision, onto: Revision, message: string): Promise<readonly FilePath[]> {
    const tip = (await this.bookmarks()).get(change);
    if (tip === undefined) {
      throw new UserError(`bookmark does not exist: ${JSON.stringify(change)}`);
    }
    if (await this.isAncestor(tip, onto)) {
      await this.advanceBranch(change, onto, tip);
      return [];
    }
    await this.assertMergeableBase(base, tip, onto);
    const conflicted = await this.workerMerge(tip, onto);
    const commit = await this.workerCommit(message);
    await this.advanceBranch(change, commit, tip);
    return conflicted;
  }
}
