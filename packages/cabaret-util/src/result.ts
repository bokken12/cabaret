import { Enum, Maybe, match, NoResume, NotUndefined, Option } from "./index.ts";

export type T<Ok, Err> = Enum<{ Ok: { ok: Ok }; Err: { err: Err } }>;

export function Ok<Ok, Err>(ok: Ok): T<Ok, Err> {
  return { kind: "Ok", ok };
}

export function Err<Ok, Err>(err: Err): T<Ok, Err> {
  return { kind: "Err", err };
}

export function ok<Ok extends NotUndefined.T, Err>(t: T<Ok, Err>): Maybe.T<Ok> {
  return match(t, {
    Err: (_) => undefined,
    Ok: (t) => t.ok,
  });
}

export function okOpt<Ok, Err>(t: T<Ok, Err>): Option.T<Ok> {
  return match(t, {
    Err: (_) => Option.None,
    Ok: (t) => Option.Some(t.ok),
  });
}

export function map<A, B, Err>(t: T<A, Err>, f: (a: A) => B): T<B, Err> {
  return match(t, {
    Err: (t) => t,
    Ok: (t) => Ok(f(t.ok)),
  });
}

export function mapErr<Ok, A, B>(t: T<Ok, A>, f: (a: A) => B): T<Ok, B> {
  return match(t, {
    Ok: (t) => t,
    Err: (t) => Err(f(t.err)),
  });
}

type Gen<Ok, Err> = Generator<Err, Ok, NoResume.T>;

export function* bind<Ok, Err extends Error>(t: T<Ok, Err>): Gen<Ok, Err> {
  if (t.kind === "Err") {
    return NoResume.absurd(yield t.err);
  }

  return t.ok;
}

export function gen<Ok, Err extends Error>(body: () => Gen<Ok, Err>): T<Ok, Err> {
  const result = body().next();

  if (!result.done) {
    return Err(result.value);
  }

  return Ok(result.value);
}
