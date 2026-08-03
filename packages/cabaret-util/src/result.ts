export type T<Ok, Err> = { kind: "ok"; ok: Ok } | { kind: "err"; err: Err };
