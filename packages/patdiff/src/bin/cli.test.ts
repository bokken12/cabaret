/** Integration tests for the patdiff CLI binary. Uses [tsx] to run the
 *  TypeScript entry point directly, skipping a separate build step. */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const entry = path.join(repoRoot, "src", "bin", "main.ts");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

const runCli = (args: readonly string[], input?: string): RunResult => {
  const result = spawnSync(tsxBin, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patdiff-cli-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeFile = (name: string, contents: string): string => {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return p;
};

describe("patdiff CLI", () => {
  it("exits 0 with empty output for identical files", () => {
    const a = writeFile("a.txt", "hello\nworld\n");
    const b = writeFile("b.txt", "hello\nworld\n");
    const r = runCli([a, b]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("exits 1 for files that differ", () => {
    const a = writeFile("a.txt", "hello\nworld\n");
    const b = writeFile("b.txt", "hello\nWORLD\n");
    const r = runCli([a, b]);
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 30_000);

  it("-make-config writes a config file", () => {
    const out = path.join(tmpDir, "patdiff.sexp");
    const r = runCli(["-make-config", out]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain("(context");
    expect(text).toContain("line_same");
  }, 30_000);

  it("-readme prints documentation text", () => {
    const r = runCli(["-readme"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PATDIFF");
    expect(r.stdout).toContain("find differences");
  }, 30_000);

  it("-version prints a version string", () => {
    const r = runCli(["-version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  it("unknown flag exits non-zero with error on stderr", () => {
    const r = runCli(["-no-such-flag"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Unknown flag");
  }, 30_000);

  it("uses default config when -default passed", () => {
    const a = writeFile("a.txt", "x\n");
    const b = writeFile("b.txt", "x\n");
    const r = runCli(["-default", a, b]);
    expect(r.status).toBe(0);
  }, 30_000);

  it("-ascii forces plain ASCII output without ANSI escapes", () => {
    const a = writeFile("a.txt", "hello\n");
    const b = writeFile("b.txt", "world\n");
    const r = runCli(["-ascii", a, b]);
    expect(r.status).toBe(1);
    // No ANSI escape codes when -ascii is used.
    expect(r.stdout).not.toMatch(/\x1b\[/);
  }, 30_000);

  it("-quiet suppresses output but preserves exit code", () => {
    const a = writeFile("a.txt", "alpha\n");
    const b = writeFile("b.txt", "beta\n");
    const r = runCli(["-quiet", a, b]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("stdin colorization: 0 args reads stdin and produces a diff", () => {
    const r = runCli([], "-removed\n+added\n");
    // The synthesized prev/next files differ, so exit code is 1.
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 30_000);
});
