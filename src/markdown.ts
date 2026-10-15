// Markdown rendering for untrusted text: issue and PR bodies, comments,
// board fields and gists are all written by others (and the bot's own
// text may quote anyone). Two layers, as docs/design.md asks:
//
// 1. markdown-it with raw HTML off, so any HTML in the source is shown as
//    text, and its default link validation (no javascript:, vbscript:,
//    file:, or data: other than images);
// 2. DOMPurify over the result, with an allowlist of tags, attributes and
//    URL schemes, returning a DocumentFragment so no HTML string ever
//    reaches an innerHTML sink.
//
// Images become plain links: loading them would tell their host when you
// read an item, and the CSP blocks third-party images anyway.

import MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";

/** Sources larger than this are cut, with a note, to keep a phone responsive. */
export const MAX_SOURCE_CHARS = 200_000;

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "s", "strong", "table", "tbody", "td", "th", "thead",
  "tr", "ul",
];
const ALLOWED_ATTR = ["href", "title", "start"];
// https, http and mailto only; relative links would resolve against this
// app's origin, which is never what an issue author meant.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

function markdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";
    const src = token.attrGet("src") ?? "";
    const alt = token.children?.map((c) => c.content).join("") || "image";
    if (!md.validateLink(src)) return md.utils.escapeHtml(`[${alt}]`);
    return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(`[image: ${alt}]`)}</a>`;
  };
  return md;
}

export type Renderer = (source: string, repository?: string) => DocumentFragment;

/**
 * Make a renderer bound to a window: the browser's, or jsdom's in tests.
 */
export function createRenderer(win: WindowLike): Renderer {
  const md = markdownIt();
  const purify = createDOMPurify(win);
  if (!purify.isSupported) {
    throw new Error("DOMPurify is not supported in this environment; refusing to render untrusted text");
  }
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (source: string, repository?: string) => {
    const cut = source.length > MAX_SOURCE_CHARS;
    const text = cut ? `${source.slice(0, MAX_SOURCE_CHARS)}\n\n*(cut: too long to show here)*` : source;
    const tokens = md.parse(text, {});
    if (repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      for (const block of tokens) {
        let depth = 0;
        block.children = block.children?.flatMap((token) => {
          if (token.type === "link_open") depth++;
          if (token.type === "link_close") depth--;
          // Only prose: never rewrite code, URLs or existing link labels.
          if (token.type !== "text" || depth) return [token];
          const result = [];
          let end = 0;
          // Do not retry at each dot/hyphen in a long non-reference word.
          const refs = /(?<![\w/.#-])(?:([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)(?![\w])/g;
          for (const match of token.content.matchAll(refs)) {
            const before = new Token("text", "", 0);
            before.content = token.content.slice(end, match.index);
            const open = new Token("link_open", "a", 1);
            open.attrSet("href", `https://github.com/${match[1] ?? repository}/issues/${match[2]}`);
            const label = new Token("text", "", 0);
            label.content = match[0];
            result.push(before, open, label, new Token("link_close", "a", -1));
            end = match.index + match[0].length;
          }
          const tail = new Token("text", "", 0);
          tail.content = token.content.slice(end);
          return [...result, tail];
        }) ?? null;
      }
    }
    return purify.sanitize(md.renderer.render(tokens, md.options, {}), PURIFY_CONFIG);
  };
}
