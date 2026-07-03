export type Sexp =
  | { readonly kind: "atom"; readonly value: string }
  | { readonly kind: "list"; readonly elements: readonly Sexp[] };

export const atom = (value: string): Sexp => ({ kind: "atom", value });
export const list = (elements: readonly Sexp[]): Sexp => ({
  kind: "list",
  elements,
});

export class SexpParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
    this.name = "SexpParseError";
  }
}

class Parser {
  private pos = 0;
  constructor(private readonly input: string) {}

  private peek(): string | undefined {
    return this.input[this.pos];
  }

  private advance(): string | undefined {
    return this.input[this.pos++];
  }

  private isAtEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private skipWhitespaceAndComments(): void {
    while (!this.isAtEnd()) {
      const c = this.peek()!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === ";") {
        while (!this.isAtEnd() && this.peek() !== "\n") this.pos++;
      } else if (c === "#" && this.input[this.pos + 1] === "|") {
        this.skipBlockComment();
      } else {
        break;
      }
    }
  }

  private skipBlockComment(): void {
    const start = this.pos;
    this.pos += 2;
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const c = this.peek()!;
      if (c === "#" && this.input[this.pos + 1] === "|") {
        this.pos += 2;
        depth++;
      } else if (c === "|" && this.input[this.pos + 1] === "#") {
        this.pos += 2;
        depth--;
      } else {
        this.pos++;
      }
    }
    if (depth !== 0) throw new SexpParseError("Unterminated block comment", start);
  }

  private parseQuotedAtom(): Sexp {
    const start = this.pos;
    this.pos++;
    let out = "";
    while (!this.isAtEnd()) {
      const c = this.advance()!;
      if (c === '"') return atom(out);
      if (c === "\\") {
        if (this.isAtEnd()) throw new SexpParseError("Unterminated string escape", start);
        const esc = this.advance()!;
        switch (esc) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case "b":
            out += "\b";
            break;
          case "\\":
            out += "\\";
            break;
          case '"':
            out += '"';
            break;
          case "'":
            out += "'";
            break;
          case " ":
            out += " ";
            break;
          case "\n":
            while (!this.isAtEnd() && (this.peek() === " " || this.peek() === "\t")) this.pos++;
            break;
          case "x": {
            const hex = this.input.slice(this.pos, this.pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new SexpParseError("Bad \\x escape", this.pos);
            this.pos += 2;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            if (esc >= "0" && esc <= "9") {
              const rest = this.input.slice(this.pos, this.pos + 2);
              if (!/^[0-9]{2}$/.test(rest)) throw new SexpParseError("Bad decimal escape", this.pos);
              this.pos += 2;
              const code = parseInt(esc + rest, 10);
              out += String.fromCharCode(code);
            } else {
              throw new SexpParseError(`Bad escape: \\${esc}`, this.pos - 1);
            }
        }
      } else {
        out += c;
      }
    }
    throw new SexpParseError("Unterminated quoted atom", start);
  }

  private parseUnquotedAtom(): Sexp {
    let out = "";
    while (!this.isAtEnd()) {
      const c = this.peek()!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === '"' || c === ";")
        break;
      out += c;
      this.pos++;
    }
    if (out.length === 0) throw new SexpParseError("Empty atom", this.pos);
    return atom(out);
  }

  private parseList(): Sexp {
    const start = this.pos;
    this.pos++;
    const out: Sexp[] = [];
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.isAtEnd()) throw new SexpParseError("Unterminated list", start);
      if (this.peek() === ")") {
        this.pos++;
        return list(out);
      }
      out.push(this.parseOne());
    }
  }

  parseOne(): Sexp {
    this.skipWhitespaceAndComments();
    if (this.isAtEnd()) throw new SexpParseError("Unexpected end of input", this.pos);
    const c = this.peek()!;
    if (c === "(") return this.parseList();
    if (c === ")") throw new SexpParseError("Unexpected ')'", this.pos);
    if (c === '"') return this.parseQuotedAtom();
    return this.parseUnquotedAtom();
  }

  parseAll(): readonly Sexp[] {
    const out: Sexp[] = [];
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.isAtEnd()) return out;
      out.push(this.parseOne());
    }
  }

  parseSingle(): Sexp {
    const result = this.parseOne();
    this.skipWhitespaceAndComments();
    if (!this.isAtEnd()) throw new SexpParseError("Extra data after sexp", this.pos);
    return result;
  }
}

export const parseSexp = (input: string): Sexp => new Parser(input).parseSingle();

export const parseSexpList = (input: string): readonly Sexp[] => new Parser(input).parseAll();

/**
 * Sexplib quotes an atom if it is empty, contains whitespace, parens, quote,
 * semicolon, backslash, control chars, or any `#|` / `|#` block-comment marker.
 */
const needsQuoting = (s: string): boolean => {
  if (s.length === 0) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 32 || c === 127) return true;
    const ch = s[i]!;
    if (ch === "(" || ch === ")" || ch === '"' || ch === ";" || ch === "\\") return true;
    if ((ch === "#" || ch === "|") && i + 1 < s.length) {
      const next = s[i + 1]!;
      if ((ch === "#" && next === "|") || (ch === "|" && next === "#")) return true;
    }
  }
  return false;
};

const escapeAtom = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\b") out += "\\b";
    else if (code < 32 || code === 127) {
      out += "\\" + code.toString(10).padStart(3, "0");
    } else out += ch;
  }
  return out + '"';
};

export const printSexp = (sexp: Sexp): string => {
  if (sexp.kind === "atom") {
    return needsQuoting(sexp.value) ? escapeAtom(sexp.value) : sexp.value;
  }
  return "(" + sexp.elements.map(printSexp).join(" ") + ")";
};

export const printSexpList = (sexps: readonly Sexp[]): string => sexps.map(printSexp).join("\n");
