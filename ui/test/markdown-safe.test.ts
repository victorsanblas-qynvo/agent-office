import { beforeEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n/index';
import { escapeHtml, isSafeHref, markdownToHtml, safeHref } from '../src/panel/markdown-safe';

beforeEach(() => applyLang('es'));

const HOSTILE_HREFS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  '\tjavascript:alert(1)',
  '\n\rjavascript:alert(1)',
  '\u0000javascript:alert(1)',
  '\u001Fjavascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'javascript\t:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/uuid',
  'tel:+34600000000',
  'http://[',
];

describe('isSafeHref', () => {
  test('accepts http, https, mailto, relative paths and anchors', () => {
    for (const href of [
      'http://example.com',
      'https://example.com/a?b=1&c=2#d',
      'HTTPS://EXAMPLE.COM',
      'mailto:someone@example.com',
      '/docs/api.md',
      'docs/api.md',
      './plan.md',
      '../plan.md',
      '#section',
      '?page=2',
      '//example.com/x',
    ]) {
      expect(isSafeHref(href), href).toBe(true);
    }
  });

  test('rejects script, data, file and other schemes however they are disguised', () => {
    for (const href of HOSTILE_HREFS) expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
  });

  test('takes an entity reference literally, as the DOM already decoded the attribute', () => {
    expect(isSafeHref('&#106;avascript:alert(1)')).toBe(true);
  });
});

describe('safeHref', () => {
  test('returns the encoded url for a safe href and null for a hostile one', () => {
    expect(safeHref('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeHref('https://example.com/%7E')).toBe('https://example.com/%7E');
    for (const href of HOSTILE_HREFS) expect(safeHref(href), JSON.stringify(href)).toBeNull();
  });

  test('a href that encodeURI cannot encode is dropped', () => {
    expect(safeHref('https://example.com/\uD800')).toBeNull();
  });
});

describe('escapeHtml', () => {
  test('escapes the five html special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml('plain text')).toBe('plain text');
  });

  test('escaping twice escapes the entities of the first pass', () => {
    expect(escapeHtml(escapeHtml('<&"\'>'))).toBe('&amp;lt;&amp;amp;&amp;quot;&amp;#39;&amp;gt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('markdownToHtml links', () => {
  test('a safe link keeps its href and title, escaped', () => {
    expect(markdownToHtml('[plan](https://example.com/?a=1&b=2 "t\'<>")')).toBe(
      '<p><a href="https://example.com/?a=1&amp;b=2" title="t&#39;&lt;&gt;">plan</a></p>\n',
    );
    expect(markdownToHtml('[api](docs/api.md#rutas)')).toBe('<p><a href="docs/api.md#rutas">api</a></p>\n');
  });

  test('a hostile link renders as its text without an anchor', () => {
    for (const markdown of [
      '[click](javascript:alert(1))',
      '[click](JaVaScRiPt:alert(1))',
      '[click](<javascript:alert(1)>)',
      '[click](<java\tscript:alert(1)>)',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[click](vbscript:msgbox(1))',
      '[click](file:///etc/passwd)',
      '[click][ref]\n\n[ref]: javascript:alert(1)',
    ]) {
      expect(markdownToHtml(markdown), markdown).toBe('<p>click</p>\n');
    }
  });

  test('a hostile autolink renders as escaped text', () => {
    expect(markdownToHtml('<javascript:alert(1)>')).toBe('<p>javascript:alert(1)</p>\n');
  });

  test('the text of a dropped link is still escaped markdown', () => {
    expect(markdownToHtml('[**bold** `code`](javascript:alert(1))')).toBe('<p><strong>bold</strong> <code>code</code></p>\n');
    expect(markdownToHtml('[a & b](javascript:alert(1))')).toBe('<p>a &amp; b</p>\n');
  });

  test('an entity-encoded scheme never reaches the browser as an entity', () => {
    for (const markdown of [
      '[x](&#106;avascript:alert(1))',
      '[x](&#x6A;avascript:alert(1))',
      '[x](javascript&colon;alert(1))',
      '[x](java&#09;script:alert(1))',
      '[x][r]\n\n[r]: &#106;avascript:alert(1)',
    ]) {
      const html = markdownToHtml(markdown);
      const href = /href="([^"]*)"/.exec(html)?.[1];
      expect(href, markdown).toBeDefined();
      expect(href, markdown).not.toMatch(/&(?!amp;)/);
    }
    expect(markdownToHtml('[x](&#106;avascript:alert(1))')).toBe('<p><a href="&amp;#106;avascript:alert(1)">x</a></p>\n');
  });

  test('www and http autolinks still become links', () => {
    expect(markdownToHtml('www.example.com')).toBe('<p><a href="http://www.example.com">www.example.com</a></p>\n');
    expect(markdownToHtml('<https://example.com>')).toBe('<p><a href="https://example.com">https://example.com</a></p>\n');
  });
});

describe('markdownToHtml images', () => {
  test('an image becomes an escaped placeholder in the active language', () => {
    expect(markdownToHtml('![a <b> & "q"](javascript:alert(1))')).toBe('<p>[imagen: a &lt;b&gt; &amp; &quot;q&quot;]</p>\n');
    expect(markdownToHtml('![](x.png)')).toBe('<p>[imagen]</p>\n');
    applyLang('en');
    expect(markdownToHtml('![diagram](x.png)')).toBe('<p>[image: diagram]</p>\n');
    expect(markdownToHtml('![](x.png)')).toBe('<p>[image]</p>\n');
  });

  test('a placeholder in the alt text is not interpolated', () => {
    expect(markdownToHtml('![{alt}](x.png)')).toBe('<p>[imagen: {alt}]</p>\n');
  });
});
