import { afterEach, describe, expect, test } from 'bun:test';
import { applyLang } from '../src/i18n';
import { leadText, metricCells, percentText, runsText } from '../src/table/metrics-model';

afterEach(() => applyLang('es'));

describe('metrics formatting', () => {
  test('humanizes durations and leaves a dash when there are none', () => {
    expect(leadText(3 * 3_600_000 + 20 * 60_000)).toBe('3 h 20 min');
    expect(leadText(45 * 60_000)).toBe('45 min');
    expect(leadText(26 * 3_600_000)).toBe('1 d 2 h');
    expect(leadText(null)).toBe('–');
  });

  test('writes shares as whole percentages', () => {
    expect(percentText(0.256)).toBe('26 %');
    expect(percentText(0)).toBe('0 %');
    expect(percentText(null)).toBe('–');
  });

  test('writes runs per order with the language decimal mark', () => {
    expect(runsText(2.25, 'es')).toBe('2,3');
    expect(runsText(2, 'en')).toBe('2.0');
  });

  test('builds the cells of a row', () => {
    expect(metricCells({ delivered: 4, medianLeadMs: 3_600_000, p90LeadMs: null, reopenRate: 0.25, firstPassGreen: null, avgRunsPerOrder: 1.5 }, 'es')).toEqual({
      delivered: '4',
      median: '1 h',
      p90: '–',
      reopened: '25 %',
      firstGreen: '–',
      runs: '1,5',
    });
  });
});
