import { t } from '../i18n';
import { escapeLine } from '../panel/report-markdown';
import { isoLocal } from '../table/history-export';
import { checksBadgeText } from './badges';
import { ageBadge, type Column } from './columns';

// Pure: the visible board as Markdown, one section per column and one bullet per card.
export function boardMarkdown(columns: readonly Column[], now: number): string {
  const out = [`# ${t('board.md.title', { date: isoLocal(now).slice(0, 16).replace('T', ' ') })}`, ''];
  for (const column of columns) {
    out.push(`## ${t(`board.col.${column.status}`)} (${column.orders.length})`, '');
    for (const order of column.orders) {
      const parts = [escapeLine(order.title), `\`${order.slug.replace(/`/g, '')}\``, escapeLine(order.floor), ageBadge(order, now, 0)?.text, checksBadgeText(order), order.pr?.url];
      out.push(`- ${parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')}`);
    }
    if (column.orders.length > 0) out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
