const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

export const isWhitespace = (c: string): boolean => WHITESPACE.has(c);

export const strip = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && isWhitespace(s[start]!)) start++;
  while (end > start && isWhitespace(s[end - 1]!)) end--;
  return s.slice(start, end);
};

/**
 * Matches OCaml's `String.split_lines`: splits on `\n` or `\r\n`. If the string
 * ends with a newline, the trailing empty string is NOT included.
 */
export const splitLines = (s: string): readonly string[] => {
  if (s === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      const end = i > 0 && s[i - 1] === "\r" ? i - 1 : i;
      lines.push(s.slice(start, end));
      start = i + 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
};

export const containsOnlyWhitespace = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (!isWhitespace(s[i]!)) return false;
  }
  return true;
};
