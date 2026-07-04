import { describe, expect, it } from "vitest";
import { bind, err, isErr, isOk, map, ok, tryCatch, unwrap, unwrapOr } from "./result.js";

describe("Result", () => {
  it("ok / err constructors", () => {
    expect(ok(1)).toEqual({ kind: "ok", value: 1 });
    expect(err("bad")).toEqual({ kind: "error", error: "bad" });
  });

  it("isOk / isErr type guards", () => {
    const a = ok(1);
    const b = err(new Error("x"));
    expect(isOk(a)).toBe(true);
    expect(isErr(a)).toBe(false);
    expect(isOk(b)).toBe(false);
    expect(isErr(b)).toBe(true);
  });

  it("map transforms ok, passes through err", () => {
    expect(map(ok(2), (x) => x * 3)).toEqual(ok(6));
    const e = err(new Error("nope"));
    expect(map(e, (x: number) => x * 3)).toBe(e);
  });

  it("bind chains computations", () => {
    const safeDiv = (a: number, b: number) => (b === 0 ? err(new Error("div0")) : ok(a / b));
    expect(bind(ok(10), (x) => safeDiv(x, 2))).toEqual(ok(5));
    expect(isErr(bind(ok(10), (x) => safeDiv(x, 0)))).toBe(true);
  });

  it("unwrap returns value on ok, throws on err", () => {
    expect(unwrap(ok(42))).toBe(42);
    expect(() => unwrap(err(new Error("boom")))).toThrow("boom");
  });

  it("unwrapOr returns fallback on err", () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err(new Error("x")), 99)).toBe(99);
  });

  it("tryCatch wraps thrown errors", () => {
    expect(tryCatch(() => 1)).toEqual(ok(1));
    const r = tryCatch(() => {
      throw new Error("boom");
    });
    expect(isErr(r)).toBe(true);
  });

  it("tryCatch wraps non-Error throws", () => {
    const r = tryCatch(() => {
      throw "string error";
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.message).toBe("string error");
    }
  });
});
