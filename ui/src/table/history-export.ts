import { fileStamp } from '../download';
import { t } from '../i18n';
import { hubText } from '../i18n/hub';
import type { SearchHit } from '../types';

export type HistoryRow = {
  time: string;
  floor: string;
  agent: string;
  session: string;
  role: string;
  kind: string;
  text: string;
};

export const HISTORY_COLUMNS: readonly (keyof HistoryRow)[] = ['time', 'floor', 'agent', 'session', 'role', 'kind', 'text'];

const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

// Pure: ISO 8601 in local time with its offset, like 2026-10-23T14:05:09.123+02:00.
export function isoLocal(ts: number): string {
  const date = new Date(ts);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${zone}`;
}

// Pure: the rows of the export, one per hit shown, in the order shown. who gives the name and role of an agent key.
export function historyRows(hits: readonly SearchHit[], who: (key: string) => { name: string; role: string } | undefined): HistoryRow[] {
  return hits.map((hit) => {
    const known = hit.agent ? who(hit.agent) : undefined;
    return {
      time: isoLocal(hit.ts),
      floor: hit.floor ?? '',
      agent: known?.name ?? hit.agent ?? '',
      session: hit.sessionId ?? '',
      role: known?.role ?? '',
      kind: hit.kind,
      text: hubText(hit.text),
    };
  });
}

function cell(value: string): string {
  const safe = /^[=+\-@\t\r＝＋－＠]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// Pure: RFC 4180 (UTF-8 BOM, comma, CRLF, a header row) with the cells that start like a formula defused by a single quote.
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header.join(','), ...rows.map((row) => row.map(cell).join(','))];
  return `\ufeff${lines.map((line) => `${line}\r\n`).join('')}`;
}

export function historyToCsv(rows: readonly HistoryRow[]): string {
  return toCsv(
    HISTORY_COLUMNS,
    rows.map((row) => HISTORY_COLUMNS.map((column) => row[column])),
  );
}

// Pure: the rows as pretty JSON with the keys always in the order of the columns.
export function historyToJson(rows: readonly HistoryRow[]): string {
  const ordered = rows.map((row) => Object.fromEntries(HISTORY_COLUMNS.map((column) => [column, row[column]])));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// Pure: agent-office-<history>-YYYYMMDD-HHMM.csv|json in local time.
export function historyFilename(ext: 'csv' | 'json', now: Date): string {
  return `agent-office-${t('history.file.name')}-${fileStamp(now)}.${ext}`;
}
