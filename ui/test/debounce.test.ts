import { describe, expect, test } from 'bun:test';
import { StateDebouncer } from '../src/debounce';
import type { AgentState, AgentView } from '../src/types';

// The UI runs in a browser; the debouncer only needs the timer pair.
Object.assign(globalThis, {
  window: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  },
});

function agent(key: string, state: AgentState): AgentView {
  return { key, state } as AgentView;
}

describe('agent state debouncer', () => {
  test('a reading/working swap settles after the delay and calls onSettle once', async () => {
    let settled = 0;
    const debouncer = new StateDebouncer(() => settled++, 10);
    debouncer.observe(agent('a', 'working'));
    expect(debouncer.shown('a')).toBe('working');

    debouncer.observe(agent('a', 'reading'));
    expect(debouncer.shown('a')).toBe('working');
    await Bun.sleep(40);
    expect(debouncer.shown('a')).toBe('reading');
    expect(settled).toBe(1);
  });

  test('going back to the state on screen cancels the pending swap', async () => {
    let settled = 0;
    const debouncer = new StateDebouncer(() => settled++, 10);
    debouncer.observe(agent('a', 'working'));
    debouncer.observe(agent('a', 'reading'));
    debouncer.observe(agent('a', 'working'));
    await Bun.sleep(40);
    expect(debouncer.shown('a')).toBe('working');
    expect(settled).toBe(0);
  });

  test('a state outside the swap pair applies at once and drops the pending one', async () => {
    let settled = 0;
    const debouncer = new StateDebouncer(() => settled++, 10);
    debouncer.observe(agent('a', 'working'));
    debouncer.observe(agent('a', 'reading'));
    debouncer.observe(agent('a', 'blocked'));
    expect(debouncer.shown('a')).toBe('blocked');
    await Bun.sleep(40);
    expect(debouncer.shown('a')).toBe('blocked');
    expect(settled).toBe(0);
  });

  test('forget drops the entry and its pending swap', async () => {
    let settled = 0;
    const debouncer = new StateDebouncer(() => settled++, 10);
    debouncer.observe(agent('a', 'working'));
    debouncer.observe(agent('a', 'reading'));
    debouncer.forget('a');
    await Bun.sleep(40);
    expect(debouncer.shown('a')).toBeUndefined();
    expect(settled).toBe(0);
  });

  test('the first state of an agent settles nothing on its own', async () => {
    let settled = 0;
    const debouncer = new StateDebouncer(() => settled++, 10);
    debouncer.observe(agent('a', 'reading'));
    await Bun.sleep(40);
    expect(debouncer.shown('a')).toBe('reading');
    expect(settled).toBe(0);
  });
});
