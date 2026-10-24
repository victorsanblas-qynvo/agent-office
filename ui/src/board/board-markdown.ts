import { t } from '../i18n';
import { escapeLine } from '../panel/report-markdown';
import { isoLocal } from '../table/history-export';
import { checksBadgeText } from './badges';
import { ageBadge, type Column, type Lane } from './columns';

function pushColumns(out: string[], columns: readonly Column[], now: number, level: string): void {
  for (const column of columns) {
    out.push(`${level} ${t(`board.col.${column.status}`)} (${column.orders.length})`, '');
    for (const order of column.orders) {
      const parts = [escapeLine(order.title), `\`${order.slug.replace(/`/g, '')}\``, escapeLine(order.floor), ageBadge(order, now, 0)?.text, checksBadgeText(order), order.pr?.url];
      out.push(`- ${parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')}`);
    }
    if (column.orders.length > 0) out.push('');
  }
}

// Pure: the visible board as Markdown, one section per column and one bullet per card; with lanes, a section
// per floor (## floor) holding its columns (### column).
export function boardMarkdown(columns: readonly Column[], now: number, lanes?: readonly Lane[]): string {
  const out = [`# ${t('board.md.title', { date: isoLocal(now).slice(0, 16).replace('T', ' ') })}`, ''];
  if (lanes) {
    for (const lane of lanes) {
      out.push(`## ${escapeLine(lane.floor)} (${lane.columns.reduce((sum, column) => sum + column.orders.length, 0)})`, '');
      pushColumns(out, lane.columns, now, '###');
    }
  } else pushColumns(out, columns, now, '##');
  return `${out.join('\n').trimEnd()}\n`;
}
