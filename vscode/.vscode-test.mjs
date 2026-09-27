import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const { Cabaret } = createRequire(import.meta.url)("@cabaret/node");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cabaret-vscode-test-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// Neither the fixture nor the extension under test sees the developer's own git config or Claude sessions.
const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_CONFIG_DIR: join(root, "claude") };
Object.assign(process.env, env);
mkdirSync(env.CLAUDE_CONFIG_DIR);

const workspace = join(root, "main");
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });

function write(files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
}

/** A trunk `main`, and `feature` on it adding two files, checked out. */
async function fixture() {
  mkdirSync(workspace);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  // Unprefixed, so changes keep the names the tests use.
  git("config", "cabaret.prefix", "");
  write({ "README.md": "# fixture\n" });
  git("add", ".");
  git("commit", "--message=initial");
  const cabaret = new Cabaret(workspace);
  await cabaret.create("feature", "main");
  await cabaret.workspaceSwitch("feature");
  write({ "src/a.txt": "a\n", "src/b.txt": "b\n" });
  await cabaret.commit("feature", []);
}

await fixture();

/**
 * The downloaded VS Code, copied as a macOS background-only app so that a test window never
 * takes focus. Editing `Info.plist` voids the signature, so the copy is re-signed ad hoc; that no
 * longer matches the keychain's grant to VS Code, hence its `--use-mock-keychain`.
 */
async function backgroundVSCode() {
  const executable = await downloadAndUnzipVSCode();
  const app = resolve(executable, "../../..");
  const copy = `${dirname(app)}-background`;
  if (!existsSync(copy)) {
    const staging = mkdtempSync(`${copy}-staging-`);
    const staged = join(staging, basename(app));
    execFileSync("cp", ["-Rc", app, staged]);
    execFileSync("plutil", ["-insert", "LSBackgroundOnly", "-bool", "YES", join(staged, "Contents/Info.plist")]);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", staged], { stdio: "pipe" });
    renameSync(staging, copy);
  }
  return join(copy, relative(dirname(app), executable));
}

export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: workspace,
  useInstallation: process.platform === "darwin" ? { fromPath: await backgroundVSCode() } : undefined,
  // Valued, as test-cli appends the workspace folder, which a bare unknown flag would swallow.
  // Chromium reads it only on macOS.
  launchArgs: ["--disable-extensions", "--use-mock-keychain=true"],
  env,
  mocha: { ui: "tdd", timeout: 20_000 },
});
