import type { OfficeApi } from '../api';
import { saveFile } from '../download';
import { button, el, type Child } from '../dom';
import { t } from '../i18n';
import { hubText } from '../i18n/hub';
import { scoreText, verdictLabel } from '../labels';
import type { Store } from '../store';
import { clockTime, relativeTime } from '../time';
import type { ReportView } from '../types';
import { reportFilename, reportMarkdown } from './report-markdown';
import { panelSection } from './section';

const REFRESH_MS = 10_000;
const FILE_LIMIT = 20;
const TEST_LIMIT = 10;
const VERDICT_LIMIT = 10;
const MESSAGE_LIMIT = 10;
const NOT_FOUND = 404;

type TimeNode = { node: HTMLElement; ts: number };

type Line = { ts: number; who: string; text: string | null };

function block(title: string, ...children: Child[]): HTMLElement {
  return el('section', 'report-block', el('h4', 'report-title', title), ...children);
}

function newest<T extends { ts: number }>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  return { shown: sorted.slice(0, limit), hidden: Math.max(0, sorted.length - limit) };
}

function more(count: number): HTMLElement | null {
  return count > 0 ? el('li', 'report-more muted', t('panel.more', { n: count })) : null;
}

function renderReport(report: ReportView, now: number, times: TimeNode[], onDownload: () => void): HTMLElement[] {
  const time = (ts: number): HTMLElement => {
    const node = el('time', 'report-time muted', relativeTime(ts, now));
    node.title = clockTime(ts);
    times.push({ node, ts });
    return node;
  };

  const lines = (items: readonly Line[], direction: 'out' | 'in'): HTMLElement =>
    el(
      'ul',
      'timeline-list',
      ...items.map((item) =>
        el(
          'li',
          `msg msg-${direction}`,
          el('div', 'msg-head', el('span', 'msg-dir', item.who), time(item.ts)),
          item.text !== null ? el('p', 'msg-text', item.text) : el('p', 'msg-text muted', t('report.noText')),
        ),
      ),
    );

  const span = el('p', 'report-span muted', `${t('report.start')} `, time(report.startedAt), ' · ');
  if (report.endedAt === null) span.append(t('report.running'));
  else span.append(`${t('report.end')} `, time(report.endedAt));

  const download = button(t('report.download'), 'doc-download', t('report.downloadTitle'));
  download.addEventListener('click', onDownload);

  const parts: HTMLElement[] = [el('p', 'report-text', (report.summaryText ? hubText(report.summaryText) : report.summary) || t('report.noSummary')), span, el('p', 'report-actions', download)];

  if (report.files.length > 0) {
    const shown = report.files.slice(0, FILE_LIMIT);
    parts.push(
      block(
        t('report.files', { n: report.files.length }),
        el(
          'ul',
          'report-list',
          ...shown.map((path) => el('li', '', el('code', 'file-path', path))),
          more(report.files.length - shown.length),
        ),
      ),
    );
  }

  if (report.tests.length > 0) {
    const { shown, hidden } = newest(report.tests, TEST_LIMIT);
    parts.push(
      block(
        t('report.tests', { n: report.tests.length }),
        el(
          'ul',
          'report-list',
          ...shown.map((test) =>
            el(
              'li',
              'report-test',
              el('span', test.ok ? 'test-ok' : 'test-fail', test.ok ? '✓' : '✗'),
              time(test.ts),
              el('code', 'report-command', test.command),
            ),
          ),
          more(hidden),
        ),
      ),
    );
  }

  if (report.verdicts.length > 0) {
    const { shown, hidden } = newest(report.verdicts, VERDICT_LIMIT);
    parts.push(
      block(
        t('report.verdicts', { n: report.verdicts.length }),
        el(
          'ul',
          'report-list',
          ...shown.map((verdict) =>
            el(
              'li',
              'report-verdict',
              el('span', `verdict verdict-${verdict.kind}`, verdictLabel(verdict.kind)),
              verdict.path !== null ? el('code', 'file-path', verdict.path) : null,
              verdict.round !== null ? el('span', 'muted', t('table.round', { n: verdict.round })) : null,
              verdict.score !== null ? el('span', 'muted', scoreText(verdict.score)) : null,
              time(verdict.ts),
            ),
          ),
          more(hidden),
        ),
      ),
    );
  }

  if (report.sent.length > 0) {
    const { shown } = newest(report.sent, MESSAGE_LIMIT);
    parts.push(
      block(
        t('report.sent', { n: report.sent.length }),
        lines(shown.map((message) => ({ ts: message.ts, who: `→ ${message.to}`, text: message.text })), 'out'),
      ),
    );
  }

  if (report.received.length > 0) {
    const { shown } = newest(report.received, MESSAGE_LIMIT);
    parts.push(
      block(
        t('report.received', { n: report.received.length }),
        lines(shown.map((message) => ({ ts: message.ts, who: `← ${message.from}`, text: message.text })), 'in'),
      ),
    );
  }

  parts.push(el('p', 'report-counts muted', t('report.counts', { questions: report.questions, blocked: report.blocked })));

  if (report.lessons.length > 0) {
    parts.push(
      block(
        t('report.lessons', { n: report.lessons.length }),
        el('ul', 'report-list', ...report.lessons.map((lesson) => el('li', 'report-lesson', lesson))),
      ),
    );
  }

  if (report.closing) parts.push(block(t('report.closing'), el('p', 'report-closing', report.closing)));

  return parts;
}

export function mountReport(host: HTMLElement, store: Store, api: OfficeApi | null): void {
  host.replaceChildren();
  host.hidden = true;
  if (api === null) return;

  const client = api;
  const chip = el('span', 'chip');
  const section = panelSection({ id: 'report', title: () => t('report.title'), host });
  const { body } = section;

  let currentKey: string | null = null;
  let ended = false;
  let report: ReportView | null = null;
  let failure: string | null = null;
  let missing = false;
  let rendered = '';
  let ticket = 0;
  let timer: number | undefined;
  let times: TimeNode[] = [];

  const stop = (): void => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };

  const render = (): void => {
    const signature = JSON.stringify([report, failure, missing]);
    if (signature === rendered) return;
    rendered = signature;
    times = [];
    section.setMeta(report === null ? null : chip);
    if (report === null) {
      const notice = missing
        ? el('p', 'muted hint', t('report.missing'))
        : failure === null
          ? el('p', 'muted hint', t('report.loading'))
          : el('p', 'report-error hint', failure);
      body.replaceChildren(notice);
      return;
    }
    chip.textContent = report.live ? t('report.live') : t('report.closed');
    const stale = failure === null ? [] : [el('p', 'report-error hint', t('panel.updateFailed', { error: failure }))];
    body.replaceChildren(...renderReport(report, store.now(), times, () => {
      if (report === null) return;
      saveFile(reportFilename(report, new Date()), reportMarkdown(report, store.agents.get(report.agentKey)), 'text/markdown');
    }), ...stale);
  };

  const load = async (key: string): Promise<void> => {
    const mine = ++ticket;
    const result = await client.report(key);
    if (mine !== ticket || key !== currentKey) return;
    if (result.ok) {
      report = result.data;
      failure = null;
      missing = false;
    } else if (result.status === NOT_FOUND && report === null) {
      missing = true;
    } else {
      failure = result.message;
    }
    render();
  };

  const sync = (): void => {
    const key = store.selectedKey;
    const agent = key === null ? undefined : store.agents.get(key);
    if (key === null || agent === undefined) {
      stop();
      ticket += 1;
      currentKey = null;
      report = null;
      failure = null;
      missing = false;
      rendered = '';
      host.hidden = true;
      return;
    }

    const isEnded = agent.endedAt !== null;
    const switched = key !== currentKey;
    if (!switched && isEnded === ended) return;

    stop();
    currentKey = key;
    ended = isEnded;
    host.hidden = false;
    if (switched) {
      report = null;
      failure = null;
      missing = false;
      rendered = '';
      render();
    }
    void load(key);
    if (!isEnded) {
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void load(key);
      }, REFRESH_MS);
    }
  };

  store.watch(['lang'], () => {
    section.setTitle();
    if (currentKey === null) return;
    rendered = '';
    render();
  });

  store.watch(['selection', 'agents'], sync);

  store.watch(['connection'], () => {
    if (store.connection === 'online' && currentKey !== null) void load(currentKey);
  });

  store.watch(['tick'], () => {
    if (host.hidden) return;
    const now = store.now();
    for (const { node, ts } of times) node.textContent = relativeTime(ts, now);
  });
}
