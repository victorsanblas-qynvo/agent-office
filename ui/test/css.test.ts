import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function cssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...cssFiles(path));
    else if (entry.name.endsWith('.css')) files.push(path);
  }
  return files;
}

// Counts braces outside comments and strings. A missing closing brace is otherwise a build warning,
// not an error: the rules after it end up nested under the wrong selector.
export function braceBalance(css: string): { open: number; close: number; minDepth: number; depth: number } {
  let open = 0;
  let close = 0;
  let depth = 0;
  let minDepth = 0;
  let quote: string | null = null;
  let comment = false;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i]!;
    const next = css[i + 1];

    if (comment) {
      if (char === '*' && next === '/') {
        comment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      comment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      open += 1;
      depth += 1;
    } else if (char === '}') {
      close += 1;
      depth -= 1;
      if (depth < minDepth) minDepth = depth;
    }
  }

  return { open, close, minDepth, depth };
}

describe('CSS stylesheets', () => {
  for (const file of cssFiles(SRC)) {
    test(`${relative(SRC, file)} has balanced braces`, () => {
      const balance = braceBalance(readFileSync(file, 'utf8'));
      expect(balance.open).toBe(balance.close);
      expect(balance.minDepth).toBeGreaterThanOrEqual(0);
      expect(balance.depth).toBe(0);
    });
  }

  test('styles.css honors the theme preference', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
    expect(css).toContain(':root[data-theme="light"] {');
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain(':root:not([data-theme="dark"]) {');
  });
});
