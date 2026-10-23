import { createTranslator, type Lang, type MessageKey } from '../i18n';
import { en } from '../i18n/en';
import { es } from '../i18n/es';
import type { DigestCounts, OfficeDigest, WeekDigest } from '../types';

function kit(lang: Lang) {
  const { t } = createTranslator(lang === 'en' ? en : es);
  const tokens = (n: number): string => {
    if (n < 1000) return String(n);
    const unit = n < 999_950 ? 'k' : 'm';
    const value = Math.round((unit === 'k' ? n / 1000 : n / 1_000_000) * 10) / 10;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${t(`tokens.unit.${unit}`)}`.replace('.', lang === 'es' ? ',' : '.');
  };
  const counts = (c: DigestCounts, line: (key: MessageKey, value: number | string) => void): void => {
    if (c.blocked > 0) line('digest.blocked', c.blocked);
    if (c.redRuns > 0) line('digest.red', c.redRuns);
    if (c.greenRuns > 0) line('digest.green', c.greenRuns);
    if (c.plans.approved > 0) line('digest.plansApproved', c.plans.approved);
    if (c.plans.noAgreement > 0) line('digest.plansNoAgreement', c.plans.noAgreement);
    if (c.lessons > 0) line('digest.lessons', c.lessons);
    if (c.tokens > 0) line('digest.tokens', tokens(c.tokens));
  };
  return { t, counts };
}

// Pure: a stand-up in plain Markdown, one section per floor and one for the total; only the lines that are not zero.
// floorName turns a slug into the label the panel shows.
export function digestText(digest: OfficeDigest, lang: Lang, floorName: (slug: string) => string = (slug) => slug): string {
  const { t, counts } = kit(lang);
  const out: string[] = [`# ${t('digest.title', { day: digest.day })}`];
  if (digest.floors.length === 0) {
    out.push('', t('digest.empty'));
    return out.join('\n');
  }
  for (const floor of digest.floors) {
    out.push('', `## ${floorName(floor.floor)}`);
    if (floor.delivered.length > 0) {
      out.push(`- ${t('digest.delivered')}: ${floor.delivered.length}`);
      for (const order of floor.delivered) out.push(`  - ${order.title} (\`${order.slug}\`)`);
    }
    counts(floor, (key, value) => out.push(`- ${t(key)}: ${value}`));
  }
  out.push('', `## ${t('digest.totals')}`);
  if (digest.totals.delivered > 0) out.push(`- ${t('digest.delivered')}: ${digest.totals.delivered}`);
  counts(digest.totals, (key, value) => out.push(`- ${t(key)}: ${value}`));
  return out.join('\n');
}

// Pure: the weekly stand-up, one section per floor with its sums, the total and one line per day.
export function weekDigestText(week: WeekDigest, lang: Lang, floorName: (slug: string) => string = (slug) => slug): string {
  const { t, counts } = kit(lang);
  const out: string[] = [`# ${t('digest.weekTitle', { from: week.from, to: week.to })}`];
  if (week.floors.length === 0) {
    out.push('', t('digest.emptyWeek'));
    return out.join('\n');
  }
  for (const floor of week.floors) {
    out.push('', `## ${floorName(floor.floor)}`);
    if (floor.delivered.length > 0) {
      out.push(`- ${t('digest.delivered')}: ${floor.delivered.length}`);
      for (const order of floor.delivered) out.push(`  - ${order.title} (\`${order.slug}\`)`);
    }
    counts(floor, (key, value) => out.push(`- ${t(key)}: ${value}`));
  }
  out.push('', `## ${t('digest.totals')}`);
  if (week.totals.delivered > 0) out.push(`- ${t('digest.delivered')}: ${week.totals.delivered}`);
  counts(week.totals, (key, value) => out.push(`- ${t(key)}: ${value}`));
  out.push('', `## ${t('digest.byDay')}`);
  for (const day of week.days) {
    const parts: string[] = [];
    if (day.totals.delivered > 0) parts.push(`${t('digest.delivered')} ${day.totals.delivered}`);
    counts(day.totals, (key, value) => parts.push(`${t(key)} ${value}`));
    out.push(`- ${day.day}: ${parts.length > 0 ? parts.join(', ') : '—'}`);
  }
  return out.join('\n');
}
