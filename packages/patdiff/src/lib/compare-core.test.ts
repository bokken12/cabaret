import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as ComparisonResult from "../kernel/comparison-result.js";
import { defaultConfiguration, override } from "../kernel/configuration.js";
import * as FileName from "../kernel/file-name.js";
import { compareFiles, diffDirs, diffFiles, withNodeIoCompare } from "./compare-core.js";

const mkTmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "patdiff-cc-"));

const writeFile = (p: string, c: string): void => fs.writeFileSync(p, c);

describe("Compare_core (Node I/O)", () => {
  it("withNodeIoCompare matches kernel for in-memory diff", () => {
    const res = withNodeIoCompare.diffStrings({
      config: override(defaultConfiguration, { output: "Ascii" }),
      prev: { name: "a", text: "hello\nworld\n" },
      next: { name: "b", text: "hello\nthere\n" },
    });
    expect(res.kind).toBe("Different");
  });

  it("compareFiles returns Same for identical files", () => {
    const dir = mkTmp();
    try {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      writeFile(a, "hello\nworld\n");
      writeFile(b, "hello\nworld\n");
      const result = compareFiles({
        config: defaultConfiguration,
        prevFile: FileName.real(a),
        nextFile: FileName.real(b),
      });
      expect(ComparisonResult.hasNoDiff(result)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compareFiles returns Different for differing files", () => {
    const dir = mkTmp();
    try {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      writeFile(a, "hello\nworld\n");
      writeFile(b, "hello\nthere\n");
      const result = compareFiles({
        config: defaultConfiguration,
        prevFile: FileName.real(a),
        nextFile: FileName.real(b),
      });
      expect(ComparisonResult.hasNoDiff(result)).toBe(false);
      expect(result.kind).toBe("Hunks");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compareFiles distinguishes binaries differing only in invalid-UTF-8 bytes", () => {
    const dir = mkTmp();
    try {
      const a = path.join(dir, "a.bin");
      const b = path.join(dir, "b.bin");
      // The differing bytes are invalid UTF-8, so both files decode to the
      // same string (U+FFFD); a post-decoding check would report BinarySame.
      fs.writeFileSync(a, Buffer.from([0x00, 0xff, 0xfe, 0x01]));
      fs.writeFileSync(b, Buffer.from([0x00, 0xff, 0xfd, 0x01]));
      const result = compareFiles({
        config: defaultConfiguration,
        prevFile: FileName.real(a),
        nextFile: FileName.real(b),
      });
      expect(result).toEqual({
        kind: "BinaryDifferent",
        prevIsBinary: true,
        nextIsBinary: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compareFiles returns BinarySame for byte-identical binaries", () => {
    const dir = mkTmp();
    try {
      const a = path.join(dir, "a.bin");
      const b = path.join(dir, "b.bin");
      fs.writeFileSync(a, Buffer.from([0x00, 0xff, 0xfe, 0x01]));
      fs.writeFileSync(b, Buffer.from([0x00, 0xff, 0xfe, 0x01]));
      const result = compareFiles({
        config: defaultConfiguration,
        prevFile: FileName.real(a),
        nextFile: FileName.real(b),
      });
      expect(result).toEqual({ kind: "BinarySame" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diffFiles returns 'Same' for identical files (quiet)", () => {
    const dir = mkTmp();
    try {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      writeFile(a, "hello\n");
      writeFile(b, "hello\n");
      const result = diffFiles({
        config: override(defaultConfiguration, { quiet: true }),
        prevFile: a,
        nextFile: b,
      });
      expect(result).toBe("Same");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diffDirs handles asymmetric directories", () => {
    const dir = mkTmp();
    try {
      const left = path.join(dir, "left");
      const right = path.join(dir, "right");
      fs.mkdirSync(left);
      fs.mkdirSync(right);
      writeFile(path.join(left, "shared.txt"), "x\n");
      writeFile(path.join(left, "only_left.txt"), "y\n");
      writeFile(path.join(right, "shared.txt"), "x\n");
      writeFile(path.join(right, "only_right_a.txt"), "a\n");
      writeFile(path.join(right, "only_right_b.txt"), "b\n");
      const result = diffDirs({
        config: override(defaultConfiguration, { quiet: true, maskUniques: true }),
        prevDir: left,
        nextDir: right,
      });
      expect(result).toBe("Different");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diffDirs returns Same when contents match", () => {
    const dir = mkTmp();
    try {
      const left = path.join(dir, "left");
      const right = path.join(dir, "right");
      fs.mkdirSync(left);
      fs.mkdirSync(right);
      writeFile(path.join(left, "a.txt"), "hello\n");
      writeFile(path.join(left, "b.txt"), "world\n");
      writeFile(path.join(right, "a.txt"), "hello\n");
      writeFile(path.join(right, "b.txt"), "world\n");
      const result = diffDirs({
        config: override(defaultConfiguration, { quiet: true }),
        prevDir: left,
        nextDir: right,
      });
      expect(result).toBe("Same");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
