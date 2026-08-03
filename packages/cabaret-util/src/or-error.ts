import { NonemptyIArray, Result } from "./index.ts";

export * from "./result.ts";

export type T<Ok, Err = Error> = Result.T<Ok, NonemptyIArray.T<Err>>;

export function ok_exn<Ok, Err>(t: T<Ok, Err>): Ok {
  if (t.kind === "err") {
    throw new AggregateError(t.err);
  }
  return t.ok;
}
