import { expect, test } from "vitest";
import { formatRepo, parseAliases, parseRepo } from "../config.js";

test("parseRepo reads bare owner/repo pairs, lowercased like remote parsing", () => {
  expect(parseRepo("Test-Org/Widgets")).toEqual({ owner: "test-org", repo: "widgets" });
  expect(parseRepo("  test-org/widgets.git ")).toEqual({ owner: "test-org", repo: "widgets" });
});

test("parseRepo reads the clone URL forms a remote would carry", () => {
  expect(parseRepo("https://github.com/test-org/widgets.git")).toEqual({ owner: "test-org", repo: "widgets" });
  expect(parseRepo("git@github.com:Test-Org/Widgets")).toEqual({ owner: "test-org", repo: "widgets" });
});

test("parseRepo refuses what names no repository", () => {
  expect(() => parseRepo("just-words")).toThrowError();
  expect(() => parseRepo("https://example.com/test-org/widgets")).toThrowError();
  expect(() => parseRepo("../..")).toThrowError();
  expect(() => parseRepo("test-org/..")).toThrowError();
  expect(() => parseRepo("./widgets")).toThrowError();
});

test("formatRepo inverts parseRepo on bare pairs", () => {
  expect(formatRepo(parseRepo("test-org/widgets"))).toBe("test-org/widgets");
});

test("parseAliases splits on commas, trimming and dropping empties", () => {
  expect(parseAliases(" alice@example.com, github:alice ,,")).toEqual(["alice@example.com", "github:alice"]);
  expect(parseAliases("")).toEqual([]);
});
