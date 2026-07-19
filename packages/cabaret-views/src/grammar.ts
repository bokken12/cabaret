import * as Patdiff4 from "patdiff/patdiff4";

/**
 * A language diff pages may embed: how its files are named, and the TextMate
 * scope of the grammar that highlights it.
 */
export interface EmbeddedLanguage {
  readonly id: string;
  /** The scope of the language's own grammar, e.g. "source.ts". */
  readonly scope: string;
  /** File suffixes claiming the language, dot included: ".ts". */
  readonly suffixes: readonly string[];
  /** Exact basenames claiming the language: "Makefile". */
  readonly basenames: readonly string[];
}

/** The subset of TextMate's rule format the page grammar emits. */
export interface GrammarRule {
  readonly include?: string;
  readonly begin?: string;
  readonly end?: string;
  readonly while?: string;
  readonly contentName?: string;
  readonly patterns?: readonly GrammarRule[];
}

export interface PageGrammar {
  readonly scopeName: "text.cabaret";
  readonly patterns: readonly GrammarRule[];
  readonly repository: Readonly<Record<string, GrammarRule>>;
}

/** Escape `text` for literal use inside an Oniguruma pattern. */
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** A diff page's hunk header: `-1,5 +1,6`, with a 4-way header's trailing role names allowed. */
const hunkHeader = "-\\d+,\\d+ \\+\\d+,\\d+";

/** A multi-file page's bar naming a file — or a moved (`->`) or copied (`=>`) file's source too — as `fileBar` renders it. */
const fileBarLine = "@+ \\S+(?: [-=]> \\S+)? @+$";

/**
 * A 4-way page's hint sentences sit between hunks, so they too must close an
 * open hunk region. The set is closed and shared with the renderer, which
 * shows them verbatim as headings.
 */
const hintLine = `(?:${Object.values(Patdiff4.Header.hint).flat().map(literal).join("|")})$`;

/**
 * The TextMate grammar for cabaret diff pages. A file's section opens at the
 * line naming it — a diff page's title or a multi-file page's @-bar — and
 * each hunk's body is its own embedded region of the file's language, so an
 * unterminated construct at the end of one hunk cannot bleed into the next.
 * Hunks are begin/while regions: an end pattern would go unchecked while an
 * embedded rule (an open block comment, say) sits on the stack, but a while
 * condition is re-checked at every line start and pops the whole stack at
 * the next structural line. Structural lines themselves stay unscoped: they
 * are chrome, not code. A file of a language nobody claims opens no section,
 * leaving its hunks plain.
 */
export function pageGrammar(languages: readonly EmbeddedLanguage[]): PageGrammar {
  const patterns: GrammarRule[] = [];
  const repository: Record<string, GrammarRule> = {};
  for (const { id, scope, suffixes, basenames } of languages) {
    const names = [
      ...suffixes.map((suffix) => `\\S*${literal(suffix)}`),
      ...basenames.map((basename) => `(?:\\S*/)?${literal(basename)}`),
    ];
    if (names.length === 0) {
      continue;
    }
    patterns.push({ include: `#file-${id}` });
    repository[`file-${id}`] = {
      // A moved or copied file's header names its source too; the destination claims the language.
      begin: `^(?:@+ )?(?:\\S+ [-=]> )?(?:${names.join("|")})(?: @+| in \\S.*)$`,
      end: `(?=^${fileBarLine})`,
      patterns: [{ include: `#hunks-${id}` }],
    };
    repository[`hunks-${id}`] = {
      begin: `^${hunkHeader}.*$`,
      while: `(^|\\G)(?!${hunkHeader})(?!${fileBarLine})(?!${hintLine})`,
      contentName: `meta.embedded.block.${id}`,
      patterns: [{ include: scope }],
    };
  }
  return { scopeName: "text.cabaret", patterns, repository };
}
