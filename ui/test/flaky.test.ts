import { describe, expect, test } from 'bun:test';
import { flakyChecks } from '../src/board/flaky';
import { flakyHits } from '../../shared/flaky';
import type { CheckRunView, CheckStatus } from '../src/types';

function run(id: number, sha: string, status: CheckStatus, name = 'test'): CheckRunView {
  return {
    id,
    orderId: 1,
    sha,
    trigger: 'comprobar',
    status: status === 'passed' ? 'passed' : 'failed',
    startedAt: id,
    endedAt: id + 1,
    checks: [{ name, command: 'bun test', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, outputTail: null }],
  };
}

describe('flakyChecks', () => {
  test('failed then passed on the same sha is flaky', () => {
    expect([...flakyChecks([run(2, 'aaa', 'passed'), run(1, 'aaa', 'failed')])]).toEqual(['test']);
  });

  test('a pass on another sha is not', () => {
    expect(flakyChecks([run(1, 'aaa', 'failed'), run(2, 'bbb', 'passed')]).size).toBe(0);
  });

  test('a timeout counts as a failure', () => {
    expect(flakyChecks([run(1, 'aaa', 'timeout'), run(2, 'aaa', 'passed')]).has('test')).toBe(true);
  });

  test('dirty runs are ignored', () => {
    expect(flakyChecks([run(1, 'aaa-dirty', 'failed'), run(2, 'aaa', 'passed')]).size).toBe(0);
    expect(flakyChecks([run(1, 'aaa', 'failed'), run(2, 'aaa-dirty', 'passed')]).size).toBe(0);
  });

  test('passed then failed is not flaky', () => {
    expect(flakyChecks([run(1, 'aaa', 'passed'), run(2, 'aaa', 'failed')]).size).toBe(0);
  });

  test('is per check name', () => {
    expect(flakyChecks([run(1, 'aaa', 'failed', 'lint'), run(2, 'aaa', 'passed', 'test')]).size).toBe(0);
  });
});

describe('flakyHits', () => {
  test('one hit per commit and check, at the run that passed', () => {
    const hits = flakyHits([run(1, 'aaa', 'failed'), run(2, 'aaa', 'passed'), run(3, 'aaa', 'failed'), run(4, 'aaa', 'passed'), run(5, 'bbb', 'failed'), run(6, 'bbb', 'passed')]);
    expect(hits).toEqual([
      { name: 'test', sha: 'aaa', at: 2 },
      { name: 'test', sha: 'bbb', at: 6 },
    ]);
  });
});
