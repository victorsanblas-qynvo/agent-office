import { createTranslator, type Lang, type MessageKey } from '../i18n';
import { en } from '../i18n/en';
import { es } from '../i18n/es';
import type { DigestCounts, OfficeDigest } from '../types';

// Pure: a stand-up in plain Markdown, one section per floor and one for the total; only the lines that are not zero.
// floorName turns a slug into the label the panel shows.
export function digestText(digest: OfficeDigest, lang: Lang, floorName: (slug: string) => string = (slug) => slug): string {
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
