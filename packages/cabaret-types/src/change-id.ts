import { z } from "zod";

declare const brand: unique symbol;

/** Stable identifier for a change, equivalent to branch name. */
export type T = string & { readonly [brand]: "ChangeID" };

export const schema = z.string().transform((s) => s as T);
