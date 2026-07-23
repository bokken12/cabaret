import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { openForge } from "../forge.js";

const execFileAsync = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

async function repository(origin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-forge-open-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", dir]);
  await execFileAsync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

test("openForge selects the forge named by origin", async () => {
  vi.stubEnv("GH_TOKEN", "github-token");
  vi.stubEnv("GITLAB_TOKEN", "gitlab-token");
  vi.stubEnv("CODEBERG_TOKEN", "codeberg-token");
  vi.stubEnv("BITBUCKET_TOKEN", "bitbucket-token");

  const origins = [
    "https://GitHub.com/Test-Org/Widgets.git",
    "git@gitlab.com:Test-Org/Platform/Widgets.git",
    "ssh://git@codeberg.org/Test-Org/Widgets.git",
    "https://alice@Bitbucket.org/Test-Org/Widgets.git",
  ] as const;
  const locators = [];
  for (const origin of origins) {
    locators.push({ origin, locator: (await openForge(await repository(origin))).locator });
  }
  expect(locators).toEqual([
    { origin: "https://GitHub.com/Test-Org/Widgets.git", locator: "github.com/test-org/widgets" },
    { origin: "git@gitlab.com:Test-Org/Platform/Widgets.git", locator: "gitlab.com/test-org/platform/widgets" },
    { origin: "ssh://git@codeberg.org/Test-Org/Widgets.git", locator: "codeberg.org/test-org/widgets" },
    { origin: "https://alice@Bitbucket.org/Test-Org/Widgets.git", locator: "bitbucket.org/test-org/widgets" },
  ]);
});

test("openForge rejects an unsupported origin before looking for credentials", async () => {
  const origin = "git@example.com:test-org/widgets.git";
  await expect(openForge(await repository(origin))).rejects.toThrow(
    `unsupported forge origin: ${JSON.stringify(origin)}; expected github.com, gitlab.com, codeberg.org, or bitbucket.org`,
  );
});

test("openForge asks for the selected forge's token", async () => {
  vi.stubEnv("GH_TOKEN", "github-token");
  vi.stubEnv("GITLAB_TOKEN", "");
  vi.stubEnv("GITLAB_ACCESS_TOKEN", "");
  await expect(openForge(await repository("https://gitlab.com/test-org/widgets.git"))).rejects.toThrow(
    "no GitLab token: set GITLAB_TOKEN",
  );
});

/** Point `gh` at a config directory with no login, so its token lookup fails deterministically. */
async function stubSignedOutGh(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-gh-config-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("GH_CONFIG_DIR", dir);
}

test("openForge falls back to the host's GitHub sign-in when ambient tokens are missing", async () => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  await stubSignedOutGh();
  const github = vi.fn().mockResolvedValue("signed-in-token");
  const forge = await openForge(await repository("https://github.com/test-org/widgets.git"), { github });
  expect({ locator: forge.locator, signIns: github.mock.calls.length }).toEqual({
    locator: "github.com/test-org/widgets",
    signIns: 1,
  });
});

test("openForge leaves the host's GitHub sign-in alone when an ambient token is set", async () => {
  vi.stubEnv("GH_TOKEN", "github-token");
  const github = vi.fn().mockResolvedValue("signed-in-token");
  await openForge(await repository("git@github.com:test-org/gadgets.git"), { github });
  expect(github).not.toHaveBeenCalled();
});

test("openForge without a GitHub sign-in reports the ways to supply a token", async () => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  await stubSignedOutGh();
  await expect(openForge(await repository("https://github.com/test-org/widgets.git"))).rejects.toThrow(
    "no GitHub token: set GH_TOKEN or run `gh auth login`",
  );
});

test("openForge validates the selected forge's URL before looking for credentials", async () => {
  vi.stubEnv("GITLAB_TOKEN", "");
  vi.stubEnv("GITLAB_ACCESS_TOKEN", "");
  await expect(openForge(await repository("https://gitlab.com/widgets.git"))).rejects.toThrow(
    'not a gitlab.com repository URL: "https://gitlab.com/widgets.git"',
  );
});
