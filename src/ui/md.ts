// Markdown from agents and imports is untrusted: no raw HTML, and only http(s), same-origin paths and
// in-page anchors survive as link or image targets.
import MarkdownIt from "markdown-it";

export function safeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  // "//host" and "/\host" are other origins in disguise.
  return /^https?:\/\//i.test(u) || /^\/(?![/\\])/.test(u) || u.startsWith("#") ? u : null;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.validateLink = (url) => safeUrl(url) !== null;

const linkOpen = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  const t = tokens[i]!;
  const href = safeUrl(t.attrGet("href"));
  t.attrSet("href", href ?? "#");
  if (href && /^https?:/i.test(href)) {
    t.attrSet("target", "_blank");
    t.attrSet("rel", "noopener noreferrer");
  }
  return linkOpen(tokens, i, opts, env, self);
};

const image = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, i, opts, env, self) => {
  const t = tokens[i]!;
  if (!safeUrl(t.attrGet("src"))) return md.utils.escapeHtml(t.content);
  t.attrSet("loading", "lazy");
  return image(tokens, i, opts, env, self);
};

export const renderMd = (text: string) => md.render(text);

/** Markdown as plain text on one line, for previews in the log. */
export const plainMd = (text: string) =>
  md.parse(text, {}).filter((t) => t.type === "inline")
    .map((t) => (t.children ?? []).map((c) => (c.type === "softbreak" || c.type === "hardbreak" ? " " : c.content)).join(""))
    .join(" ");
