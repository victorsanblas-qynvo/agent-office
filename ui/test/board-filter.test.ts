import { beforeAll, describe, expect, test } from 'bun:test';
import { ageBadge, filterOrders } from '../src/board/columns';
import { applyLang } from '../src/i18n/index';
import { order } from './fixtures';

beforeAll(() => applyLang('es'));

const HOUR = 3_600_000;

describe('filterOrders', () => {
  const orders = [
    order('login-flow', { id: 1, title: 'Pantalla de sesión', branch: 'encargo/login-flow', status: 'en-curso' }),
    order('pagos', { id: 2, title: 'Pagos con tarjeta', branch: 'encargo/pagos', status: 'revision' }),
    order('perfil', { id: 3, title: 'Perfil', branch: null, status: 'pendiente', floor: 'backend' }),
  ];
  const slugs = (query: string, label?: (slug: string) => string): string[] => filterOrders(orders, query, label).map((o) => o.slug);

  test('an empty query keeps every order', () => {
    expect(slugs('')).toEqual(['login-flow', 'pagos', 'perfil']);
    expect(slugs('   ')).toEqual(['login-flow', 'pagos', 'perfil']);
  });

  test('every term must match, in any order', () => {
    expect(slugs('pagos tarjeta')).toEqual(['pagos']);
    expect(slugs('tarjeta pagos')).toEqual(['pagos']);
    expect(slugs('pagos sesion')).toEqual([]);
  });

  test('ignores case and accents', () => {
    expect(slugs('SESION')).toEqual(['login-flow']);
    expect(slugs('sesión')).toEqual(['login-flow']);
  });

  test('matches slug, branch, floor and floor label', () => {
    expect(slugs('encargo/login')).toEqual(['login-flow']);
    expect(slugs('backend')).toEqual(['perfil']);
    expect(slugs('planta-b', (slug) => (slug === 'backend' ? 'Planta-B' : slug))).toEqual(['perfil']);
  });

  test('matches the status label', () => {
    expect(slugs('revision')).toEqual(['pagos']);
    expect(slugs('en curso')).toEqual(['login-flow']);
    expect(slugs('pendiente perfil')).toEqual(['perfil']);
  });
});

describe('ageBadge', () => {
  const now = 1_000 * HOUR;
  const at = (hours: number, status: 'pendiente' | 'en-curso' | 'revision' | 'hecho' | 'descartado' = 'revision') => order('a', { status, updatedAt: now - hours * HOUR });

  test('formats minutes, hours and days with the column', () => {
    expect(ageBadge(at(0.5), now, 24)?.text).toBe('30 min en Revisión');
    expect(ageBadge(at(3), now, 24)?.text).toBe('3 h en Revisión');
    expect(ageBadge(at(23), now, 24)?.text).toBe('23 h en Revisión');
    expect(ageBadge(at(50), now, 24)?.text).toBe('2 d en Revisión');
    expect(ageBadge(at(5, 'en-curso'), now, 24)?.text).toBe('5 h en En curso');
  });

  test('is stale only past the threshold', () => {
    expect(ageBadge(at(23.9), now, 24)?.stale).toBe(false);
    expect(ageBadge(at(24), now, 24)?.stale).toBe(false);
    expect(ageBadge(at(24.01), now, 24)?.stale).toBe(true);
    expect(ageBadge(at(7), now, 6)?.stale).toBe(true);
  });

  test('never stale when the pref is off', () => {
    expect(ageBadge(at(500), now, 0)).toEqual({ text: '20 d en Revisión', stale: false });
  });

  test('finished orders have none', () => {
    expect(ageBadge(at(100, 'hecho'), now, 24)).toBeNull();
    expect(ageBadge(at(100, 'descartado'), now, 24)).toBeNull();
  });

  test('a clock behind the card never goes negative', () => {
    expect(ageBadge(at(-2), now, 24)).toEqual({ text: '0 min en Revisión', stale: false });
  });
});
