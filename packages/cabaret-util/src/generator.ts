import { Result } from "./index.ts";

// TODO-someday(jm): reconsider type parameter names
type T<Yield, Break, Resume> = Generator<Yield, Break, Resume>;

export function iter<Y, B, R>(t: T<Y, B, R>, f: (y: Y) => R): B {
  let r: [] | [R] = [];
  while (true) {
    const result = t.next(...r);
    if (result.done) {
      return result.value;
    }

    // TODO-someday(jm): reuse rather than recreate the array?
    r = [f(result.value)];
  }
}

export function iter_until<Y, A, B, R>(t: T<Y, A, R>, fin: (a: A) => B, f: (y: Y) => Result.T<R, B>): B {
  let r: [] | [R] = [];
  while (true) {
    const result = t.next(...r);
    if (result.done) {
      return fin(result.value);
    }

    const decision = f(result.value);
    if (decision.kind === "Err") {
      return decision.err;
    }

    r = [decision.ok];
  }
}
