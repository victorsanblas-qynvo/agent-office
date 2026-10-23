import { plural, t } from '../i18n';
import { formatTokens } from '../labels';
import type { OrderSpend } from '../types';

// The spend line of an order drawer; an order that has cost nothing shows none.
export function spendLine(spend: OrderSpend): string | null {
  if (spend.tokens <= 0) return null;
  return t('board.spend.line', { tokens: formatTokens(spend.tokens), sessions: plural('board.spend.sessions', spend.sessions) });
}

export function spendTitle(spend: OrderSpend, slug: string): string {
  const rows = (label: string, parts: string[]): string[] => (parts.length > 0 ? [`${label}: ${parts.join(' · ')}`] : []);
  return [
    ...rows(t('board.spend.byModel'), spend.byModel.map((row) => `${row.model || '?'} ${formatTokens(row.tokens)}`)),
    ...rows(t('board.spend.byRole'), spend.byRole.map((row) => `${row.role || '?'} ${formatTokens(row.tokens)}`)),
    t('board.spend.basis', { slug }),
  ].join('\n');
}
