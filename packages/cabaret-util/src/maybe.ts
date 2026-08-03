import { NotUndefined } from "./index.ts";

export type T<A extends NotUndefined.T> = A | undefined;
