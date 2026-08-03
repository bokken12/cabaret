import * as Result from "./result.ts";

export * from "./result.ts";

export type T<A> = Result.T<A, Error>;
