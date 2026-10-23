import { Marked } from 'marked';
import { t } from '../i18n';

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function isSafeHref(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href, 'http://relative.invalid').protocol);
  } catch {
    return false;
  }
}

export function safeHref(href: string): string | null {
  if (!isSafeHref(href)) return null;
  let encoded: string;
  try {
    encoded = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return isSafeHref(encoded) ? encoded : null;
}

const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeHref(href);
      if (url === null) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(url)}"${titleAttr}>${text}</a>`;
    },
    image: ({ text }) => escapeHtml(text ? t('markdown.image', { alt: text }) : t('markdown.imageNoAlt')),
    checkbox: ({ checked }) => (checked ? '☑ ' : '☐ '),
  },
});

export function markdownToHtml(markdown: string): string {
  return parser.parse(markdown, { async: false });
}
