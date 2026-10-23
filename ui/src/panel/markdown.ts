import DOMPurify from 'dompurify';
import { el } from '../dom';
import { isSafeHref, markdownToHtml } from './markdown-safe';

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
];

const ALLOWED_ATTR = ['href', 'title', 'align', 'start', 'colspan', 'rowspan', 'open'];

const ALLOWED_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z0-9+.\-:]|$))/i;

function plain(markdown: string): HTMLElement {
  return el('div', 'markdown', el('pre', 'markdown-plain', markdown));
}

export function renderMarkdown(markdown: string): HTMLElement {
  if (!DOMPurify.isSupported) return plain(markdown);

  let html: string;
  try {
    html = markdownToHtml(markdown);
  } catch {
    return plain(markdown);
  }

  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });

  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (href !== null && !isSafeHref(href)) link.removeAttribute('href');
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('target', '_blank');
  }

  const root = el('div', 'markdown');
  root.append(fragment);
  return root;
}
