import { writeFileSync } from "node:fs";
import { type EmbeddedLanguage, pageGrammar } from "cabaret-views";
import * as vscode from "vscode";
import { z } from "zod";

/** The language and grammar contributions read off an installed extension's manifest. */
interface Contributions {
  readonly languages?:
    | readonly { id: string; extensions?: string[] | undefined; filenames?: string[] | undefined }[]
    | undefined;
  readonly grammars?: readonly { language?: string | undefined; scopeName: string }[] | undefined;
}

// Foreign manifests are wild, so one malformed entry drops that entry alone,
// not the whole extension's contributions.
const languagePoint = z.object({
  id: z.string(),
  extensions: z.array(z.string()).optional(),
  filenames: z.array(z.string()).optional(),
});
const grammarPoint = z.object({ language: z.string().optional(), scopeName: z.string() });
const manifest = z.object({
  contributes: z
    .object({
      languages: z.array(z.unknown()).optional(),
      grammars: z.array(z.unknown()).optional(),
    })
    .optional(),
});

function contributions(packageJSON: unknown): Contributions {
  const contributes = manifest.safeParse(packageJSON).data?.contributes;
  return {
    languages: contributes?.languages?.flatMap((entry) => languagePoint.safeParse(entry).data ?? []),
    grammars: contributes?.grammars?.flatMap((entry) => grammarPoint.safeParse(entry).data ?? []),
  };
}

/**
 * Every installed language a diff page can embed, read off the extension
 * registry the way VS Code's own detection reads it: the first contribution
 * of a suffix or basename owns it (built-ins register first), and simple
 * `files.associations` patterns override both. What has no expression here —
 * glob associations, first-line matches — falls back to plain text.
 */
export function installedLanguages(): EmbeddedLanguage[] {
  const scopes = new Map<string, string>();
  const suffixOwner = new Map<string, string>();
  const basenameOwner = new Map<string, string>();
  for (const extension of vscode.extensions.all) {
    const { languages, grammars } = contributions(extension.packageJSON);
    for (const { language, scopeName } of grammars ?? []) {
      if (language !== undefined && !scopes.has(language)) {
        scopes.set(language, scopeName);
      }
    }
    for (const { id, extensions, filenames } of languages ?? []) {
      for (const suffix of extensions ?? []) {
        if (!suffixOwner.has(suffix)) {
          suffixOwner.set(suffix, id);
        }
      }
      for (const basename of filenames ?? []) {
        if (!basenameOwner.has(basename)) {
          basenameOwner.set(basename, id);
        }
      }
    }
  }
  const associations = vscode.workspace.getConfiguration("files").get<Record<string, unknown>>("associations") ?? {};
  const glob = /[*?[\]{}]/;
  for (const [pattern, language] of Object.entries(associations)) {
    if (typeof language !== "string") {
      continue;
    }
    if (pattern.startsWith("*.") && !glob.test(pattern.slice(2))) {
      suffixOwner.set(pattern.slice(1), language);
    } else if (!glob.test(pattern) && !pattern.includes("/")) {
      basenameOwner.set(pattern, language);
    }
  }
  const names = new Map<string, { suffixes: string[]; basenames: string[] }>();
  const claim = (id: string): { suffixes: string[]; basenames: string[] } => {
    const claimed = names.get(id) ?? { suffixes: [], basenames: [] };
    names.set(id, claimed);
    return claimed;
  };
  for (const [suffix, id] of suffixOwner) {
    claim(id).suffixes.push(suffix);
  }
  for (const [basename, id] of basenameOwner) {
    claim(id).basenames.push(basename);
  }
  return [...names]
    .flatMap(([id, { suffixes, basenames }]) => {
      const scope = scopes.get(id);
      return scope === undefined ? [] : [{ id, scope, suffixes, basenames }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Regenerate the page grammar from the live registry. VS Code reads the
 * contributed grammar file lazily, at the session's first diff page, so a
 * file written during activation is always the one loaded; a language
 * extension installed mid-session shows up on the next window reload.
 */
export function writePageGrammar(context: vscode.ExtensionContext): void {
  const path = vscode.Uri.joinPath(context.extensionUri, "dist", "cabaret.tmLanguage.json").fsPath;
  writeFileSync(path, JSON.stringify(pageGrammar(installedLanguages())));
}
