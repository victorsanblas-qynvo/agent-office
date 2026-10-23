import type { DiagnosticsView } from '../types';

export function bytesText(bytes: number | null, decimal: (value: number) => string): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${decimal(bytes)} B`;
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${decimal(bytes / 1024 / 1024)} MB`;
  return `${decimal(bytes / 1024 / 1024 / 1024)} GB`;
}

export function msText(ms: number | null, decimal: (value: number) => string): string {
  return ms === null ? '—' : `${decimal(ms)} ms`;
}

export function uptimeText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return `${Math.floor(Math.max(0, ms) / 1000)} s`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

export type DiagnosticsEnv = { userAgent: string; lang: string };

const fixed = (value: number): string => value.toFixed(1);

// Pure: a Markdown block for a bug report. The log goes in a fence one backtick longer than the longest run inside it.
export function diagnosticsMarkdown(view: DiagnosticsView, env: DiagnosticsEnv): string {
  const log = view.logTail.join('\n');
  const longest = Math.max(0, ...(log.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [
    '## Agent Office diagnostics',
    '',
    `- Version: ${view.version ?? '—'}`,
    `- Schema: ${view.schema}`,
    `- Uptime: ${uptimeText(view.uptimeMs)}`,
    `- Database size: ${bytesText(view.dbBytes, fixed)}`,
    `- FTS5: ${view.fts ? 'on' : 'off'}`,
    `- Hook latency (${view.hook.count} calls): p50 ${msText(view.hook.p50, fixed)}, p95 ${msText(view.hook.p95, fixed)}, p99 ${msText(view.hook.p99, fixed)}`,
    `- Active check runs: ${view.activeCheckRuns}`,
    `- Worktrees: ${view.worktrees}`,
    `- Sessions: ${view.sessions}`,
    `- Browser: ${env.userAgent}`,
    `- Panel language: ${env.lang}`,
    '',
    'Log tail:',
    '',
    fence,
    log,
    fence,
  ].join('\n');
}
