# Coding Style

## Sweeksification

Cabaret borrows the practice of "sweeksifying" from OCaml. It involves writing files like

```typescript
// or-undefined.ts
type T<A> = A | undefined

export function value<A>(t: T<A>, default: A): A {
    if (t === undefined) {
        return default;
    }
    return t;
}
```

Then in other files, we write

```typescript
import * as OrUndefined from "./or-undefined.ts";

export function foo(x: OrUndefined.T<number>) {
    return OrUndefined.value(x, 0);
}
```

Note that two patterns are quite important here:

1. Types typically get their own file which acts as their module, collecting their associated functions. Within this file, the type is called `T`.
2. Rather than importing individual types or functions, we `import * as Name` for the whole module, after which the type is `Name.T`.

One consequence of TypeScript's lack of a module system besides files is that we may often have patterns like this to represent an outer module with inner submodules:

```typescript
// outer.ts
export * as Inner1 from "./outer/inner1.ts";
export * as Inner2 from "./outer/inner2.ts";
```
