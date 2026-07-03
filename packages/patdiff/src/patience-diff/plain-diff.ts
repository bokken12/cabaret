/** Basic Myers diff algorithm, translated from GNU diff. Originally from camlp5
    (ocaml_src/lib/diff.ml). */

// A partition is the midpoint of the shortest edit script for a specified portion of two
// vectors. [xmid, ymid] is the midpoint discovered. [loMinimal] is true iff the minimal
// edit script for the left half of the partition is known; similarly for [hiMinimal].
type Partition = {
  xmid: number;
  ymid: number;
  loMinimal: boolean;
  hiMinimal: boolean;
};

const INT_MAX = Number.MAX_SAFE_INTEGER;

// Find the midpoint of the shortest edit script for a specified portion of the two
// vectors. Scan from beginnings and ends simultaneously. When the two searches meet, we
// have the midpoint of the shortest edit sequence.
//
// If [findMinimal] is true, find the minimal edit script regardless of expense.
// Otherwise, if the search is too expensive, use heuristics to stop and report a
// suboptimal answer.
function diag<T>(
  fd: number[],
  bd: number[],
  sh: number,
  xv: (i: number) => T,
  yv: (i: number) => T,
  xoff: number,
  xlim: number,
  yoff: number,
  ylim: number,
  tooExpensive: number,
  findMinimal: boolean,
): Partition {
  const dmin = xoff - ylim;
  const dmax = xlim - yoff;
  const fmid = xoff - yoff;
  const bmid = xlim - ylim;
  const odd = ((fmid - bmid) & 1) !== 0;
  fd[sh + fmid] = xoff;
  bd[sh + bmid] = xlim;

  let c = 1;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;

  for (;;) {
    if (fmin > dmin) {
      fd[sh + fmin - 2] = -1;
      fmin -= 1;
    } else {
      fmin += 1;
    }
    if (fmax < dmax) {
      fd[sh + fmax + 2] = -1;
      fmax += 1;
    } else {
      fmax -= 1;
    }
    // Forward extend
    {
      let d = fmax;
      while (d >= fmin) {
        const tlo = fd[sh + d - 1]!;
        const thi = fd[sh + d + 1]!;
        let x = tlo >= thi ? tlo + 1 : thi;
        let y = x - d;
        while (x < xlim && y < ylim && xv(x) === yv(y)) {
          x += 1;
          y += 1;
        }
        fd[sh + d] = x;
        if (odd && bmin <= d && d <= bmax && bd[sh + d]! <= fd[sh + d]!) {
          return { xmid: x, ymid: y, loMinimal: true, hiMinimal: true };
        }
        d -= 2;
      }
    }
    // Backward extend
    if (bmin > dmin) {
      bd[sh + bmin - 2] = INT_MAX;
      bmin -= 1;
    } else {
      bmin += 1;
    }
    if (bmax < dmax) {
      bd[sh + bmax + 2] = INT_MAX;
      bmax += 1;
    } else {
      bmax -= 1;
    }
    {
      let d = bmax;
      while (d >= bmin) {
        const tlo = bd[sh + d - 1]!;
        const thi = bd[sh + d + 1]!;
        let x = tlo < thi ? tlo : thi - 1;
        let y = x - d;
        while (x > xoff && y > yoff && xv(x - 1) === yv(y - 1)) {
          x -= 1;
          y -= 1;
        }
        bd[sh + d] = x;
        if (!odd && fmin <= d && d <= fmax && bd[sh + d]! <= fd[sh + d]!) {
          return { xmid: x, ymid: y, loMinimal: true, hiMinimal: true };
        }
        d -= 2;
      }
    }

    // Heuristic
    if (!findMinimal && c >= tooExpensive) {
      let fxybest = -1;
      let fxbest = fmax;
      {
        let d = fmax;
        while (d >= fmin) {
          let x = Math.min(fd[sh + d]!, xlim);
          let y = x - d;
          if (ylim < y) {
            x = ylim + d;
            y = ylim;
          }
          if (fxybest < x + y) {
            fxybest = x + y;
            fxbest = x;
          }
          d -= 2;
        }
      }
      let bxybest = INT_MAX;
      let bxbest = bmax;
      {
        let d = bmax;
        while (d >= bmin) {
          let x = Math.max(xoff, bd[sh + d]!);
          let y = x - d;
          if (y < yoff) {
            x = yoff + d;
            y = yoff;
          }
          if (x + y < bxybest) {
            bxybest = x + y;
            bxbest = x;
          }
          d -= 2;
        }
      }
      if (xlim + ylim - bxybest < fxybest - (xoff + yoff)) {
        return {
          xmid: fxbest,
          ymid: fxybest - fxbest,
          loMinimal: true,
          hiMinimal: false,
        };
      }
      return {
        xmid: bxbest,
        ymid: bxybest - bxbest,
        loMinimal: false,
        hiMinimal: true,
      };
    }
    c += 1;
  }
}

function diffLoop<T>(
  cutoff: number | undefined,
  a: T[],
  ai: number[],
  b: T[],
  bi: number[],
  n: number,
  m: number,
): [boolean[], boolean[]] {
  const fd: number[] = new Array(n + m + 3).fill(0);
  const bd: number[] = new Array(n + m + 3).fill(0);
  const sh = m + 1;
  let tooExpensive: number;
  if (cutoff !== undefined) {
    tooExpensive = cutoff;
  } else {
    let diags = n + m + 3;
    let te = 1;
    while (diags !== 0) {
      diags = diags >> 2;
      te = te << 1;
    }
    tooExpensive = Math.max(4096, te);
  }
  const xvec = (i: number): T => a[ai[i]!]!;
  const yvec = (j: number): T => b[bi[j]!]!;
  const chng1: boolean[] = new Array(a.length).fill(true);
  const chng2: boolean[] = new Array(b.length).fill(true);
  for (let i = 0; i < n; i++) chng1[ai[i]!] = false;
  for (let j = 0; j < m; j++) chng2[bi[j]!] = false;

  const stack: Array<{
    xoff: number;
    xlim: number;
    yoff: number;
    ylim: number;
    findMinimal: boolean;
  }> = [{ xoff: 0, xlim: n, yoff: 0, ylim: m, findMinimal: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    let { xoff, xlim, yoff, ylim } = frame;
    const { findMinimal } = frame;
    while (xoff < xlim && yoff < ylim && xvec(xoff) === yvec(yoff)) {
      xoff += 1;
      yoff += 1;
    }
    while (xlim > xoff && ylim > yoff && xvec(xlim - 1) === yvec(ylim - 1)) {
      xlim -= 1;
      ylim -= 1;
    }
    if (xoff === xlim) {
      for (let y = yoff; y < ylim; y++) chng2[bi[y]!] = true;
    } else if (yoff === ylim) {
      for (let x = xoff; x < xlim; x++) chng1[ai[x]!] = true;
    } else {
      const part = diag(fd, bd, sh, xvec, yvec, xoff, xlim, yoff, ylim, tooExpensive, findMinimal);
      // Push the high half first so the low half is processed first (matches OCaml's
      // call order).
      stack.push({
        xoff: part.xmid,
        xlim,
        yoff: part.ymid,
        ylim,
        findMinimal: part.hiMinimal,
      });
      stack.push({
        xoff,
        xlim: part.xmid,
        yoff,
        ylim: part.ymid,
        findMinimal: part.loMinimal,
      });
    }
  }
  return [chng1, chng2];
}

// [makeIndexer hash a b] returns an array of the indices of items of [a] which are also
// present in [b]. At the same time, this function updates [a] and [b] so that all equal
// items point to the same unique item — letting the main algorithm use reference equality
// (===) instead of structural comparison.
function makeIndexer<T>(hash: (x: T) => string | number, a: T[], b: T[]): number[] {
  const n = a.length;
  const htb = new Map<string | number, T>();
  for (let i = 0; i < b.length; i++) {
    const e = b[i]!;
    const h = hash(e);
    const existing = htb.get(h);
    if (existing !== undefined) {
      b[i] = existing;
    } else {
      htb.set(h, e);
    }
  }
  const ai: number[] = new Array(n).fill(0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const v = htb.get(hash(a[i]!));
    if (v !== undefined) {
      a[i] = v;
      ai[k] = i;
      k += 1;
    }
  }
  return ai.slice(0, k);
}

function runDiff<T>(
  cutoff: number | undefined,
  hash: (x: T) => string | number,
  a: T[],
  b: T[],
): [boolean[], boolean[]] {
  const ai = makeIndexer(hash, a, b);
  const bi = makeIndexer(hash, b, a);
  return diffLoop(cutoff, a, ai, b, bi, ai.length, bi.length);
}

/** [iterMatches({a, b, hash, f, cutoff?})] diffs the arrays [a] and [b] (as in
    /usr/bin/diff), and calls [f] on each element of the longest common subsequence in
    increasing order. The arguments of [f] are the indices in [a] and [b], respectively,
    of that element.

    The [cutoff] is an upper bound on the minimum edit distance between [a] and [b]. When
    [cutoff] is exceeded, [iterMatches] returns a correct, but not necessarily minimal
    diff. It defaults to about sqrt(a.length + b.length). */
export function iterMatches<T>(args: {
  a: ReadonlyArray<T>;
  b: ReadonlyArray<T>;
  hash: (x: T) => string | number;
  f: (pair: [number, number]) => void;
  cutoff?: number;
}): void {
  // We mutate copies in [makeIndexer], so duplicate the inputs.
  const a = args.a.slice();
  const b = args.b.slice();
  const [d1, d2] = runDiff(args.cutoff, args.hash, a, b);
  let i1 = 0;
  let i2 = 0;
  while (i1 < d1.length && i2 < d2.length) {
    if (!d1[i1]) {
      if (!d2[i2]) {
        args.f([i1, i2]);
        i1 += 1;
        i2 += 1;
      } else {
        i2 += 1;
      }
    } else if (!d2[i2]) {
      i1 += 1;
    } else {
      i1 += 1;
      i2 += 1;
    }
  }
}
