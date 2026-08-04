import { NonemptyIArray, Result } from "./index.ts";

export * from "./result.ts";

export type T<Ok, Err extends Error = Error> = Result.T<Ok, NonemptyIArray.T<Err>>;

export function ok_exn<Ok, Err extends Error>(t: T<Ok, Err>): Ok {
  if (t.kind === "err") {
    throw new AggregateError(t.err);
  }
  return t.ok;
}

export function try_with<Ok>(f: () => Ok): T<Ok> {
  try {
    return Result.make(f());
  } catch (error) {
    if (error instanceof Error) {
      return Result.make_err([error]);
    } else {
      return Result.make_err([new Error("threw non-Error")]);
    }
  }
}
