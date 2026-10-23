import { fileStamp } from '../download';
import { t } from '../i18n';
import { hubText } from '../i18n/hub';
import { formatTokens, verdictLabel } from '../labels';
import { isoLocal } from '../table/history-export';
import type { AgentView, ReportView } from '../types';

const SESSION_CHARS = 8;

// Pure: one line of agent text with its newlines folded and its first character defused, so it can't open a heading, quote, list, table or fence.
export function escapeLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.replace(/^([#>\-*+|`]|\d+[.)])/, '\\$1');
}

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`## ${heading}`, '', ...lines.map((line) => `- ${line}`), ''];
}

// Pure: the report as Markdown. The agent is the live record, if the store still has it, for the session, last activity and context.
export function reportMarkdown(report: ReportView, agent?: AgentView): string {
  const name = report.name ?? report.agentKey;
  const title = [escapeLine(name), report.role !== null ? ` — ${escapeLine(report.role)}` : '', ` · ${escapeLine(report.floor)}`].join('');
  const meta: string[] = [];
  if (agent !== undefined) meta.push(`${t('report.md.session')}: ${agent.sessionId.slice(0, SESSION_CHARS)}`);
  meta.push(`${t('report.start')}: ${isoLocal(report.startedAt)}`);
  if (report.endedAt !== null) meta.push(`${t('report.end')}: ${isoLocal(report.endedAt)}`);
  if (agent !== undefined) meta.push(`${t('report.md.activity')}: ${isoLocal(agent.updatedAt)}`);
  if (report.tokens !== null) {
    const { input, cacheRead, cacheCreate, output, turns } = report.tokens;
    meta.push(`${t('report.md.tokens')}: ${formatTokens(input + cacheRead + cacheCreate + output)} (${turns})`);
  }
  if (agent?.context) meta.push(`${t('report.md.context')}: ${Math.round(agent.context.usedPct)} %`);
  meta.push(t('report.counts', { questions: report.questions, blocked: report.blocked }));

  const verdicts = report.verdicts.map((verdict) =>
    [
      verdictLabel(verdict.kind),
      verdict.path !== null ? escapeLine(verdict.path) : null,
      verdict.round !== null ? t('table.round', { n: verdict.round }) : null,
      verdict.score !== null ? `${verdict.score}` : null,
      isoLocal(verdict.ts),
    ]
      .filter((part) => part !== null)
      .join(' · '),
  );
  const chronological = <T extends { ts: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => a.ts - b.ts);
  const message = (who: string, ts: number, text: string | null): string => `${isoLocal(ts)} ${escapeLine(who)}: ${text !== null ? escapeLine(text) : t('report.noText')}`;

  const summary = (report.summaryText ? hubText(report.summaryText) : report.summary) || t('report.noSummary');
  const out = [
    `# ${title}`,
    '',
    ...meta.map((line) => `- ${line}`),
    '',
    ...section(t('report.md.summary'), [escapeLine(summary)]),
    ...section(t('report.files', { n: report.files.length }), report.files.map(escapeLine)),
    ...section(
      t('report.tests', { n: report.tests.length }),
      chronological(report.tests).map((test) => `${test.ok ? '✓' : '✗'} ${isoLocal(test.ts)} ${escapeLine(test.command)}`),
    ),
    ...section(t('report.verdicts', { n: report.verdicts.length }), verdicts),
    ...section(t('report.sent', { n: report.sent.length }), chronological(report.sent).map((m) => message(`→ ${m.to}`, m.ts, m.text))),
    ...section(t('report.received', { n: report.received.length }), chronological(report.received).map((m) => message(`← ${m.from}`, m.ts, m.text))),
    ...section(t('report.lessons', { n: report.lessons.length }), report.lessons.map(escapeLine)),
    ...section(t('report.closing'), report.closing ? [escapeLine(report.closing)] : []),
  ];
  return `${out.join('\n').trimEnd()}\n`;
}

// Pure: informe-<agent>-YYYYMMDD-HHMM.md, the agent reduced to [a-z0-9-].
export function reportFilename(report: Pick<ReportView, 'name' | 'agentKey'>, now: Date): string {
  const slug = (report.name ?? report.agentKey)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `informe-${slug || 'agente'}-${fileStamp(now)}.md`;
}
