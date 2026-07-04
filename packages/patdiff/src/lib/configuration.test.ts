import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import { atom, list, parseSexp, printSexp } from "../shared/sexp.js";
import {
  colorOfSexp,
  darkBg,
  defaultString,
  getConfig,
  lightBg,
  loadExn,
  onDiskOfSexp,
  parse,
  saveDefault,
  sexpOfColor,
  sexpOfStyle,
  styleOfSexp,
} from "./configuration.js";

describe("Configuration: sexp helpers", () => {
  it("parses lowercase color atoms", () => {
    expect(colorOfSexp(atom("red"))).toEqual(Color.Standard("Red"));
    expect(colorOfSexp(atom("Blue"))).toEqual(Color.Standard("Blue"));
    expect(colorOfSexp(atom("gray"))).toEqual(Color.Bright("Black"));
    expect(colorOfSexp(atom("bright_red"))).toEqual(Color.Bright("Red"));
  });

  it("parses structured Color sexps", () => {
    const c = colorOfSexp(parseSexp("(Standard Red)"));
    expect(c).toEqual(Color.Standard("Red"));
    const c2 = colorOfSexp(parseSexp("(Bright Black)"));
    expect(c2).toEqual(Color.Bright("Black"));
  });

  it("round-trips style sexps", () => {
    const s = Attr.Fg(Color.Standard("Red"));
    const sexp = sexpOfStyle(s);
    expect(printSexp(sexp)).toBe("(Fg (Standard Red))");
    expect(styleOfSexp(sexp)).toEqual(s);
  });

  it("parses simple style atoms case-insensitively", () => {
    expect(styleOfSexp(atom("Bold"))).toEqual(Attr.Bold);
    expect(styleOfSexp(atom("bold"))).toEqual(Attr.Bold);
    expect(styleOfSexp(atom("dim"))).toEqual(Attr.Faint);
  });

  it("round-trips Color sexps", () => {
    const c = Color.Standard("Green");
    expect(colorOfSexp(sexpOfColor(c))).toEqual(c);
  });
});

describe("Configuration: parse", () => {
  it("parses defaultString", () => {
    const sexp = parseSexp(defaultString);
    const onDisk = onDiskOfSexp(sexp);
    const config = parse(onDisk);
    // Default context should be the kernel default (16).
    expect(config.context).toBe(16);
    expect(config.output).toBe("Ansi");
  });

  it("parses a minimal V3 config from a string", () => {
    const sexp = parseSexp("((context 5) (output ansi))");
    const onDisk = onDiskOfSexp(sexp);
    expect(onDisk.context).toBe(5);
    const config = parse(onDisk);
    expect(config.context).toBe(5);
  });

  it("parses output side_by_side", () => {
    const sexp = parseSexp("((output (side_by_side wrap)))");
    const onDisk = onDiskOfSexp(sexp);
    const config = parse(onDisk);
    expect(config.sideBySide).toBe("wrap");
  });

  it("parses V1 config (with unrefined+html booleans) via fallback", () => {
    const sexp = parseSexp("((context 3) (unrefined true) (html true))");
    const onDisk = onDiskOfSexp(sexp);
    expect(onDisk.context).toBe(3);
    const config = parse(onDisk);
    expect(config.output).toBe("Html");
    expect(config.unrefined).toBe(true);
  });
});

describe("Configuration: dark_bg / light_bg", () => {
  it("loads darkBg", () => {
    const dark = darkBg();
    expect(dark.context).toBe(8);
  });

  it("loads lightBg", () => {
    const light = lightBg();
    expect(light.context).toBe(8);
  });
});

describe("Configuration: file loaders", () => {
  it("saveDefault + loadExn round-trips", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patdiff-config-"));
    try {
      const file = path.join(dir, ".patdiff");
      saveDefault({ filename: file });
      const cfg = loadExn(file);
      expect(cfg.context).toBe(16);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getConfig with empty filename returns default", () => {
    const cfg = getConfig({ filename: "" });
    expect(cfg.context).toBe(16);
  });
});

describe("Configuration: round-trip", () => {
  it("re-parses the printed default rule shape", () => {
    const inner = "((Fg (Standard Red)))";
    const sexp = parseSexp(inner);
    const styles = sexp.kind === "list" ? sexp.elements.map(styleOfSexp) : [];
    expect(styles).toEqual([Attr.Fg(Color.Standard("Red"))]);
    expect(printSexp(list(styles.map(sexpOfStyle)))).toBe(inner);
  });
});
