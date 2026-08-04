import { NonemptyIarray, Result } from "./index.ts";

export * from "./result.ts";

export type T<Ok, Err extends Error = Error> = Result.T<Ok, NonemptyIarray.T<Err>>;

export function okExn<Ok, Err extends Error>(t: T<Ok, Err>): Ok {
  if (t.kind === "err") {
    throw new AggregateError(t.err);
  }
  return t.ok;
}

export function tryWith<Ok>(f: () => Ok): T<Ok> {
  try {
    return Result.make(f());
  } catch (error) {
    if (error instanceof Error) {
      return Result.makeErr([error]);
    } else {
      return Result.makeErr([new Error("threw non-Error")]);
    }
  }
}
