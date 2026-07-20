import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

/** One run of foreground-colored source text; an uncolored run wears the page's own colors. */
export interface CodeToken {
  readonly text: string;
  readonly color: string | undefined;
}

/**
 * Foreground tokens for single lines of source, or undefined while the
 * file's grammar is still loading (or it has none). Highlighting is
 * line-at-a-time with no grammar state across lines, so a construct
 * spanning lines — a block comment, say — colors imperfectly past its
 * first line; diffs interleave both sides' lines, and no single threading
 * of state would be right for both.
 */
export interface CodeHighlighter {
  tokens(file: string, text: string): readonly CodeToken[] | undefined;
}

/** Grammars offered, each fetched the first time a file of its kind renders. */
const LANGS = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  ruby: () => import("@shikijs/langs/ruby"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  sql: () => import("@shikijs/langs/sql"),
};

const EXTENSIONS: Readonly<Record<string, keyof typeof LANGS>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  html: "html",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sql: "sql",
};

const THEME = "dark-plus";

/**
 * A highlighter that answers synchronously from the grammars loaded so far,
 * fetching missing ones in the background — a paint must not wait on the
 * network. `onLoaded` reports each grammar's arrival so the host can paint
 * again with it.
 */
export function codeHighlighter(onLoaded: () => void): CodeHighlighter {
  let core: HighlighterCore | undefined;
  const ready = new Set<keyof typeof LANGS>();
  const asked = new Set<keyof typeof LANGS>();
  // Forgiving: a grammar pattern the JavaScript engine cannot convert
  // tokenizes to plain runs rather than throwing mid-paint.
  const started = createHighlighterCore({
    themes: [import("@shikijs/themes/dark-plus")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  void started
    .then((created) => {
      core = created;
    })
    // A core that fails to come up leaves every page uncolored; the loads
    // below fail and report the same way.
    .catch(() => undefined);
  return {
    tokens(file: string, text: string): readonly CodeToken[] | undefined {
      const dot = file.lastIndexOf(".");
      const lang = dot === -1 ? undefined : EXTENSIONS[file.slice(dot + 1).toLowerCase()];
      if (lang === undefined) {
        return undefined;
      }
      const held = core;
      if (!ready.has(lang) || held === undefined) {
        if (!asked.has(lang)) {
          asked.add(lang);
          void started
            .then(async (created) => {
              await created.loadLanguage(LANGS[lang]());
              ready.add(lang);
              onLoaded();
            })
            // A failed load leaves its files uncolored; forgetting the ask
            // lets a later render try again.
            .catch(() => {
              asked.delete(lang);
            });
        }
        return undefined;
      }
      try {
        const [tokens] = held.codeToTokensBase(text, { lang, theme: THEME });
        return (tokens ?? []).map(({ content, color }) => ({ text: content, color }));
      } catch {
        // Coloring must never take the page down with it.
        return undefined;
      }
    },
  };
}
