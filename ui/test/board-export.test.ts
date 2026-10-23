import { beforeAll, describe, expect, test } from 'bun:test';
import { boardMarkdown } from '../src/board/board-markdown';
import { columnsOf } from '../src/board/columns';
import { ghCommand } from '../src/board/gh-command';
import { applyLang } from '../src/i18n/index';
import { order } from './fixtures';

beforeAll(() => applyLang('es'));

const NOW = new Date(2026, 9, 24, 9, 30, 0).getTime();

describe('boardMarkdown', () => {
  const orders = [
    order('login', { id: 1, title: '# Login\nflow', status: 'revision', updatedAt: NOW - 5 * 3_600_000, pr: { url: 'https://github.com/o/r/pull/3', state: 'open' }, checks: { status: 'passed', passed: 3, total: 3, touched: [], forced: false } as never }),
    order('pagos', { id: 2, title: 'Pagos', status: 'hecho' }),
  ];

  test('one section per column with its count and a bullet per card', () => {
    const md = boardMarkdown(columnsOf(orders, null), NOW);
    expect(md).toContain('# Tablero — 2026-10-24 09:30');
    expect(md).toContain('## Pendiente (0)');
    expect(md).toContain('## Revisión (1)');
    expect(md).toContain('- \\# Login flow · `login` · mobile · 5 h en Revisión · ✓ 3/3 · https://github.com/o/r/pull/3');
    expect(md).toContain('- Pagos · `pagos` · mobile\n');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('lists only the columns it is given', () => {
    const md = boardMarkdown(columnsOf(orders, 'backend'), NOW);
    expect(md).not.toContain('login');
    expect(md).toContain('## Hecho (0)');
  });
});

describe('ghCommand', () => {
  const draft = { title: "Fix it's", body: 'a\n\nb\n- c' };

  test('quotes the title and keeps the body lines', () => {
    expect(ghCommand(draft, 'main', 'encargo/x')).toBe("gh pr create --base main --head encargo/x --title 'Fix it'\\''s' --body-file - <<'AGENT_OFFICE_PR'\na\n\nb\n- c\nAGENT_OFFICE_PR");
  });

  test('picks another delimiter when a body line equals it', () => {
    const out = ghCommand({ title: 't', body: 'x\nAGENT_OFFICE_PR\nAGENT_OFFICE_PR_2' }, 'main', 'b');
    expect(out).toEndWith("<<'AGENT_OFFICE_PR_3'\nx\nAGENT_OFFICE_PR\nAGENT_OFFICE_PR_2\nAGENT_OFFICE_PR_3");
  });

  test('quotes unsafe refs and omits unknown ones', () => {
    expect(ghCommand(draft, null, 'a b')).toContain("gh pr create --head 'a b' --title");
  });
});
