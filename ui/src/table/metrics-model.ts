import type { DeliveryStats } from '../types';
import { duration } from '../time';

export const METRIC_DAYS = [7, 14, 30] as const;
export type MetricDays = (typeof METRIC_DAYS)[number];
export const DEFAULT_METRIC_DAYS: MetricDays = 14;

const DASH = '–';

// Pure: a 0..1 share as a whole percentage, a dash when there is none.
export function percentText(share: number | null): string {
  return share === null ? DASH : `${Math.round(share * 100)} %`;
}

// Pure: a duration in milliseconds as "3 h 20 min", a dash when there is none.
export function leadText(ms: number | null): string {
  return ms === null ? DASH : duration(ms);
}

// Pure: runs per order with one decimal and a comma in Spanish.
export function runsText(average: number, lang: 'es' | 'en'): string {
  const value = (Math.round(average * 10) / 10).toFixed(1);
  return lang === 'es' ? value.replace('.', ',') : value;
}

export type MetricCells = { delivered: string; median: string; p90: string; reopened: string; firstGreen: string; runs: string };

export function metricCells(stats: DeliveryStats, lang: 'es' | 'en'): MetricCells {
  return {
    delivered: String(stats.delivered),
    median: leadText(stats.medianLeadMs),
    p90: leadText(stats.p90LeadMs),
    reopened: percentText(stats.reopenRate),
    firstGreen: percentText(stats.firstPassGreen),
    runs: runsText(stats.avgRunsPerOrder, lang),
  };
}
