import { describe, expect, test } from 'bun:test';
import { applyLang, t } from '../src/i18n';
import { blockedKey, restorableCount, shortSha } from '../src/settings/deleted-branches-model';
import type { DeletedBranchView } from '../src/types';

const view = (over: Partial<DeletedBranchView> = {}): DeletedBranchView => ({
  floor: 'mobile',
  branch: 'encargo/login-a1b2',
  sha: '0123456789abcdef0123456789abcdef01234567',
  at: 1_800_000_000_000,
  restorable: true,
  reason: null,
  ...over,
});

describe('deleted branches', () => {
  test('a restorable branch has no block and counts', () => {
    expect(blockedKey(view())).toBeNull();
    expect(restorableCount([view(), view({ restorable: false, reason: 'exists' }), view({ sha: 'f'.repeat(40) })])).toBe(2);
  });

  test('a blocked branch names its reason, and an unanswered check reads as unknown', () => {
    applyLang('es');
    expect(blockedKey(view({ restorable: false, reason: 'exists' }))).toBe('settings.branches.blocked.exists');
    expect(blockedKey(view({ restorable: false, reason: 'gone' }))).toBe('settings.branches.blocked.gone');
    expect(blockedKey(view({ restorable: false, reason: null }))).toBe('settings.branches.blocked.unknown');
    expect(t(blockedKey(view({ restorable: false, reason: 'gone' })) ?? 'settings.branches.restore')).toBe('Git ya no tiene ese commit');
  });

  test('the sha is shown with its first seven characters', () => {
    expect(shortSha(view().sha)).toBe('0123456');
  });
});
