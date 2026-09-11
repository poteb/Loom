import { marked, type Tokens } from "marked";

const NAME_CHARS = "A-Za-z0-9_.-";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : null;
}

/**
 * Renders message Markdown to HTML with all raw HTML escaped, unsafe link schemes dropped,
 * and resolved @mentions wrapped in <span class="mention">. Mentions inside code are left alone.
 */
export function renderMarkdown(text: string, participants: { id: string; name: string }[], mentionIds: string[]): string {
  const mentioned = new Set(mentionIds);
  const byName = new Map(participants.map((p) => [p.name.toLowerCase(), p.id]));
  const mentionRe = new RegExp(`(?<![${NAME_CHARS}])@([${NAME_CHARS}]+)`, "g");

  const highlight = (escaped: string) => escaped.replace(mentionRe, (m, raw: string) => {
    let name = raw;
    let id = byName.get(name.toLowerCase());
    while (!id && name.endsWith(".")) { name = name.slice(0, -1); id = byName.get(name.toLowerCase()); }
    if (!id || !mentioned.has(id)) return m;
    const rest = raw.slice(name.length);
    return `<span class="mention">@${name}</span>${rest}`;
  });

  const renderer = new marked.Renderer();
  renderer.html = ({ text: t }: Tokens.HTML | Tokens.Tag) => escapeHtml(t);
  renderer.text = (token: Tokens.Text | Tokens.Escape) => highlight(escapeHtml(token.text));
  renderer.codespan = ({ text: t }: Tokens.Codespan) => `<code>${escapeHtml(t)}</code>`;
  renderer.code = ({ text: t, lang }: Tokens.Code) =>
    `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(t)}</code></pre>\n`;
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const safe = safeHref(href);
    const inner = this.parser.parseInline(tokens);
    if (!safe) return inner;
    return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""} rel="noopener noreferrer" target="_blank">${inner}</a>`;
  };
  renderer.image = ({ text: alt }: Tokens.Image) => escapeHtml(alt);

  return marked.parse(text, { renderer, gfm: true, breaks: true, async: false }) as string;
}
