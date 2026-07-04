import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as FileName from "../kernel/file-name.js";
import { nodeMtime } from "./html-output.js";

describe("html_output: nodeMtime", () => {
  it("reads mtime from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patdiff-html-"));
    try {
      const file = path.join(dir, "f.txt");
      fs.writeFileSync(file, "hello");
      const r = nodeMtime.mtime(FileName.real(file));
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") {
        expect(r.value).toBeInstanceOf(Date);
        expect(r.value.getTime()).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns Err for missing file", () => {
    const r = nodeMtime.mtime(FileName.real("/nonexistent/path/file"));
    expect(r.kind).toBe("error");
  });
});
