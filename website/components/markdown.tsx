import { Marked, Renderer } from "marked";
import { CopyCommand } from "@/components/copy-command";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function safeUrl(href: string) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href, "https://cabaret.local").protocol);
  } catch {
    return false;
  }
}
const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  if (!safeUrl(href)) return text;
  return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`;
};
renderer.image = ({ href, title, text }) =>
  safeUrl(href)
    ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`
    : escapeHtml(text);
const markdown = new Marked({ renderer, gfm: true, async: false });

export function Markdown({ children }: { children: string }) {
  const tokens = markdown.lexer(children);
  return tokens.map((token, index) =>
    token.type === "code" ? (
      <CopyCommand key={index} command={token.text} compact />
    ) : (
      <div
        key={index}
        className="markdown-block"
        dangerouslySetInnerHTML={{ __html: markdown.parser(Object.assign([token], { links: tokens.links })) }}
      />
    ),
  );
}
