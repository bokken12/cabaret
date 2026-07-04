export type Result<T, E = Error> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: E };

export type OrError<T> = Result<T, Error>;

export const ok = <T>(value: T): Result<T, never> => ({ kind: "ok", value });

export const err = <E>(error: E): Result<never, E> => ({
  kind: "error",
  error,
});

export const isOk = <T, E>(r: Result<T, E>): r is { readonly kind: "ok"; readonly value: T } => r.kind === "ok";

export const isErr = <T, E>(r: Result<T, E>): r is { readonly kind: "error"; readonly error: E } => r.kind === "error";

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> => (r.kind === "ok" ? ok(f(r.value)) : r);

export const bind = <T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E> =>
  r.kind === "ok" ? f(r.value) : r;

export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.kind === "ok") return r.value;
  throw r.error instanceof Error ? r.error : new Error(`unwrap on Err: ${String(r.error)}`);
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.kind === "ok" ? r.value : fallback);

export const tryCatch = <T>(fn: () => T): OrError<T> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
