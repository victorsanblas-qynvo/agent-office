import { describe, expect, test } from 'bun:test';
import { bytesText, msText, uptimeText } from '../src/settings/diagnostics-model';

const decimal = (value: number): string => String(Math.round(value * 10) / 10);

describe('diagnostics formatting', () => {
  test('bytes are humanized', () => {
    expect(bytesText(null, decimal)).toBe('—');
    expect(bytesText(512, decimal)).toBe('512 B');
    expect(bytesText(1536, decimal)).toBe('1.5 KB');
    expect(bytesText(5 * 1024 * 1024, decimal)).toBe('5 MB');
    expect(bytesText(3 * 1024 ** 3, decimal)).toBe('3 GB');
  });

  test('milliseconds keep one decimal and null is a dash', () => {
    expect(msText(null, decimal)).toBe('—');
    expect(msText(1.26, decimal)).toBe('1.3 ms');
  });

  test('uptime reads in the largest units', () => {
    expect(uptimeText(5000)).toBe('5 s');
    expect(uptimeText(5 * 60_000)).toBe('5 min');
    expect(uptimeText(125 * 60_000)).toBe('2 h 5 min');
    expect(uptimeText(50 * 3_600_000)).toBe('2 d 2 h');
  });
});
