/** Each move identified in the code is given a unique move ID which can be used to
    distinguish it from other moves. */

declare const moveIdBrand: unique symbol;
export type MoveId = number & { readonly [moveIdBrand]: true };

export const MoveId = {
  zero: 0 as MoveId,
  succ: (id: MoveId): MoveId => (id + 1) as MoveId,
  toString: (id: MoveId): string => id.toString(),
  equal: (a: MoveId, b: MoveId): boolean => a === b,
  compare: (a: MoveId, b: MoveId): number => a - b,
};
