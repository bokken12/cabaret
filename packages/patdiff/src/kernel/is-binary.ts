const prefixLength = 8000;

const containsNull = (s: string, len: number): boolean => {
  const n = Math.min(len, s.length);
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
};

export const string = (s: string): boolean => containsNull(s, prefixLength);

/** Detect on raw bytes, before any decoding can smooth over invalid sequences. */
export const bytes = (b: Uint8Array): boolean => {
  const n = Math.min(prefixLength, b.length);
  for (let i = 0; i < n; i++) {
    if (b[i] === 0) return true;
  }
  return false;
};

export const array = (a: readonly string[]): boolean => {
  let len = 0;
  for (const line of a) {
    if (string(line)) return true;
    len += line.length;
    if (len >= prefixLength) return false;
  }
  return false;
};
