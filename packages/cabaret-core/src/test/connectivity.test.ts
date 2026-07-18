import { expect, test } from "vitest";
import { isConnectivityError } from "../connectivity.js";

test("a libuv error code on the error itself is connectivity", () => {
  expect(isConnectivityError(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }))).toBe(true);
});

test("a libuv error code on fetch's wrapped cause is connectivity", () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" });
  expect(isConnectivityError(Object.assign(new Error("fetch failed"), { cause }))).toBe(true);
});

test.each([
  "fatal: unable to access 'https://github.com/bokken12/cabaret/': Could not resolve host: github.com",
  "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known",
  "ssh: connect to host github.com port 22: Operation timed out",
  "ssh: connect to host github.com port 22: Connection refused",
  "ssh: connect to host github.com port 22: Network is unreachable",
])("git/ssh network message is connectivity: %s", (message) => {
  expect(isConnectivityError(new Error(message))).toBe(true);
});

test("a real error (bad credentials) is not connectivity", () => {
  expect(
    isConnectivityError(new Error("fatal: Authentication failed for 'https://github.com/bokken12/cabaret/'")),
  ).toBe(false);
});

test("git's generic remote-read failure is not classified as connectivity (ambiguous with auth)", () => {
  expect(
    isConnectivityError(
      new Error("fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights"),
    ),
  ).toBe(false);
});

test("a non-Error thrown value is not connectivity", () => {
  expect(isConnectivityError("just a string")).toBe(false);
  expect(isConnectivityError(undefined)).toBe(false);
});
