import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

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

export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: workspace,
  launchArgs: ["--disable-extensions"],
  env,
  mocha: { ui: "tdd", timeout: 20_000 },
});
