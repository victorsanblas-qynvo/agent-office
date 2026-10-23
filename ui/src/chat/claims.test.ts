import { describe, expect, test } from 'bun:test';
import type { ChatKind, ChatMessageView } from '../types';
import { CLAIM_TTL_MS, collisions, heldClaims, openClaims } from './claims';

const NOW = 1_800_000_000_000;

function message(id: number, author: string, kind: ChatKind, files: string[], ts = NOW - 60_000): ChatMessageView {
  return {
    id,
    ts,
    channel: 'mobile',
    floor: 'mobile',
    authorKey: author,
    authorName: author,
    role: 'office-dev-mobile',
    roleId: 'dev',
    origin: 'agent',
    kind,
    text: '',
    files,
  };
}

describe('openClaims', () => {
  test('a toca stays open until the same author says listo', () => {
    const claimed = [message(1, 'dev-1', 'toca', ['lib/a.dart', 'lib/b.dart'])];
    expect(openClaims(claimed, NOW).map((c) => c.file)).toEqual(['lib/a.dart', 'lib/b.dart']);
    const released = [...claimed, message(2, 'dev-1', 'listo', ['lib/a.dart'])];
    expect(openClaims(released, NOW).map((c) => c.file)).toEqual(['lib/b.dart']);
  });

  test('a listo of another author does not close the claim', () => {
    const messages = [message(1, 'dev-1', 'toca', ['lib/a.dart']), message(2, 'dev-2', 'listo', ['lib/a.dart'])];
    expect(openClaims(messages, NOW)).toEqual([{ file: 'lib/a.dart', authorKey: 'dev-1', authorName: 'dev-1', ts: NOW - 60_000, id: 1 }]);
  });

  test('a listo by file name closes a claim with its folder', () => {
    const messages = [message(1, 'dev-1', 'toca', ['lib/screens/login.dart']), message(2, 'dev-1', 'listo', ['login.dart'])];
    expect(openClaims(messages, NOW)).toEqual([]);
  });

  test('a claim older than four hours has expired', () => {
    const messages = [message(1, 'dev-1', 'toca', ['lib/a.dart'], NOW - CLAIM_TTL_MS - 1), message(2, 'dev-2', 'texto', [])];
    expect(openClaims(messages, NOW)).toEqual([]);
  });
});

describe('collisions', () => {
  const held = (messages: ChatMessageView[]) => collisions(heldClaims(messages, NOW));

  test('none when every file has one holder', () => {
    expect(held([message(1, 'dev-1', 'toca', ['a.dart']), message(2, 'dev-2', 'toca', ['b.dart'])])).toEqual([]);
  });

  test('an exact overlap lists both holders, newest first', () => {
    const found = held([message(1, 'dev-1', 'toca', ['lib/a.dart'], NOW - 5000), message(2, 'dev-2', 'toca', ['lib/a.dart'], NOW - 1000)]);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('lib/a.dart');
    expect(found[0].channel).toBe('mobile');
    expect(found[0].since).toBe(NOW - 1000);
    expect(found[0].holders.map((h) => [h.key, h.floor])).toEqual([
      ['dev-2', 'mobile'],
      ['dev-1', 'mobile'],
    ]);
  });

  test('the same session twice is not a collision', () => {
    expect(held([message(1, 'dev-1', 'toca', ['lib/a.dart']), message(2, 'dev-1', 'toca', ['lib/a.dart'])])).toEqual([]);
  });

  test('a bare name matches the same name under a folder, as in the hub', () => {
    const found = held([message(1, 'dev-1', 'toca', ['a.dart']), message(2, 'dev-2', 'toca', ['lib/a.dart'])]);
    expect(found.map((c) => c.path)).toEqual(['lib/a.dart']);
    expect(held([message(1, 'dev-1', 'toca', ['x/a.dart']), message(2, 'dev-2', 'toca', ['y/a.dart'])])).toEqual([]);
  });

  test('released and expired claims are ignored', () => {
    const released = [message(1, 'dev-1', 'toca', ['a.dart']), message(2, 'dev-2', 'toca', ['a.dart']), message(3, 'dev-2', 'listo', ['a.dart'])];
    expect(held(released)).toEqual([]);
    expect(held([message(1, 'dev-1', 'toca', ['a.dart'], NOW - CLAIM_TTL_MS - 1), message(2, 'dev-2', 'toca', ['a.dart'])])).toEqual([]);
  });

  test('claims of different channels never collide, and the most recent collision sorts first', () => {
    const other = { ...message(1, 'dev-3', 'toca', ['a.dart']), channel: 'backend', floor: 'backend' };
    expect(held([message(2, 'dev-1', 'toca', ['a.dart']), other])).toEqual([]);
    const found = held([
      message(1, 'dev-1', 'toca', ['old.dart'], NOW - 9000),
      message(2, 'dev-2', 'toca', ['old.dart'], NOW - 8000),
      message(3, 'dev-1', 'toca', ['new.dart'], NOW - 3000),
      message(4, 'dev-2', 'toca', ['new.dart'], NOW - 2000),
    ]);
    expect(found.map((c) => c.path)).toEqual(['new.dart', 'old.dart']);
  });
});
