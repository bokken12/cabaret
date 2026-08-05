import { match, NonemptyIarray, Result } from "./index.ts";

export * from "./result.ts";

export type T<Ok, Err extends Error = Error> = Result.T<Ok, NonemptyIarray.T<Err>>;

export function okExn<Ok, Err extends Error>(t: T<Ok, Err>): Ok {
  return match(t, {
    Err: (t) => {
      throw new AggregateError(t.err);
    },
    Ok: (t) => t.ok,
  });
}

export function tryWith<Ok>(f: () => Ok): T<Ok> {
  try {
    return Result.Ok(f());
  } catch (error) {
    if (error instanceof Error) {
      return Result.Err([error]);
    } else {
      return Result.Err([new Error("threw non-Error")]);
    }
  }
}
