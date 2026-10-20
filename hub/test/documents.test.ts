import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { DocumentDesk, PLANS_DIR, SKILLS_DIR } from '../src/documents';
import type { DocumentView } from '../src/types';
import { tempDir } from './helpers';

function deskFor(root: string, seen: DocumentView[][]): DocumentDesk {
  return new DocumentDesk({
    db: openDb(':memory:'),
    root: () => root,
    enabled: () => ({ redaccion: true, mantenimiento: true }),
    installTargets: () => [],
    base: () => [],
    ahead: () => [],
    onChange: (docs) => seen.push(docs),
    maxRounds: () => 3,
  });
}

// Waits for the debounced refresh to see the path, and returns what it saw either way. FSEvents may only be
// live a moment after watch(): when the path does not show up quickly, `again` writes it once more.
async function waitForSeen(seen: DocumentView[][], path: string, again?: () => void): Promise<string[]> {
  const start = Date.now();
  let next = start + 500;
  for (;;) {
    const paths = seen.flat().map((doc) => doc.path);
    if (paths.includes(path) || Date.now() - start > 8000) return paths;
    if (again && Date.now() >= next) {
      again();
      next = Date.now() + 1000;
    }
    await Bun.sleep(25);
  }
}

describe('documents watcher', () => {
  test('watch() attaches a directory that did not exist on the first call', async () => {
    const { dir, cleanup } = tempDir();
    mkdirSync(join(dir, PLANS_DIR), { recursive: true });
    const seen: DocumentView[][] = [];
    const desk = deskFor(dir, seen);
    desk.watch();

    // A config reload calls watch() again: the skill lands in the directory that was missing before.
    mkdirSync(join(dir, SKILLS_DIR, 'demo'), { recursive: true });
    desk.watch();
    seen.length = 0;
    const skill = (): void => writeFileSync(join(dir, SKILLS_DIR, 'demo', 'SKILL.md'), '---\nname: Demo\n---\n');
    skill();
    expect(await waitForSeen(seen, 'taller/skills/demo', skill)).toContain('taller/skills/demo');

    // The directory that was already watched keeps working.
    seen.length = 0;
    const plan = (): void => writeFileSync(join(dir, PLANS_DIR, 'plan-a.md'), '# Plan A\n');
    plan();
    expect(await waitForSeen(seen, 'redaccion/planes/plan-a.md', plan)).toContain('redaccion/planes/plan-a.md');

    desk.unwatch();
    cleanup();
  });
});
