import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, t } from '../i18n';
import { floorLabel } from '../labels';
import type { Store } from '../store';
import { clockTime, relativeTime } from '../time';
import type { CheckRunView, CheckView, CheckpointView, OrderDiff, OrderDiffFile, OrderView, SkippedFile } from '../types';
import { checksBadgeNode, folderBadgeNode } from './badges';
import { flakyChecks } from './flaky';
import { diffStale, diffSummary, latestSha, orderSignature, patchRows, shouldReloadForChecks, statRows } from './diff-model';
import type { RunMark } from './diff-model';
import { parseDiff } from './diff-parse';
import { openPrDraft } from './pr-draft';

export type OrderDetail = { destroy(): void };

type TabName = 'checks' | 'points' | 'diff';

function seconds(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${new Intl.NumberFormat(currentLang(), { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${new Intl.NumberFormat(currentLang(), { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
}

function flakyChip(): HTMLElement {
  const chip = el('span', 'chip check-flaky', t('board.check.flaky'));
  chip.title = t('board.check.flaky.hint');
  return chip;
}

function checkRow(check: CheckView, flaky: ReadonlySet<string>): HTMLElement {
  const icon = check.status === 'passed' ? '✓' : check.status === 'failed' || check.status === 'timeout' ? '✗' : check.status === 'running' ? '' : '·';
  const head = el(
    'div',
    'check-head',
    el('span', check.status === 'running' ? 'spinner' : `check-mark check-${check.status}`, icon),
    el('b', 'check-name', check.name),
    flaky.has(check.name) ? flakyChip() : null,
    el('span', 'muted', t(`board.check.status.${check.status}`)),
    check.exitCode !== null && check.exitCode !== 0 ? el('span', 'muted', t('board.check.exit', { code: check.exitCode })) : null,
    check.durationMs !== null ? el('span', 'muted', seconds(check.durationMs)) : null,
  );
  const output = check.outputTail
    ? el('details', 'check-output', el('summary', '', t('board.check.output')), el('pre', '', check.outputTail))
    : null;
  if (output && (check.status === 'failed' || check.status === 'timeout')) output.open = true;
  return el('li', 'check-row', head, el('code', 'check-command muted', check.command), output);
}

const AGE_REPAINT_MS = 30_000;

function ageNode(ts: number, now: number, className = 'muted'): HTMLElement {
  const node = el('time', className, relativeTime(ts, now));
  node.dataset.ts = String(ts);
  return node;
}

function runBlock(run: CheckRunView, now: number, first: boolean, flaky: ReadonlySet<string>): HTMLElement {
  const sha = el('code', '', run.sha.slice(0, 7));
  const block = el(
    'section',
    `run run-${run.status}`,
    el(
      'header',
      'run-head',
      el('b', '', t(`board.checks.run.${run.status}`)),
      el('span', 'muted', t(`board.trigger.${run.trigger}`)),
      sha,
      ageNode(run.startedAt, now),
    ),
    el('ul', 'checks-list', ...run.checks.map((check) => checkRow(check, flaky))),
  );
  if (!first) block.classList.add('run-old');
  return block;
}

function pointRow(point: CheckpointView, now: number): HTMLElement {
  return el(
    'li',
    'point-row',
    el('code', '', point.sha.slice(0, 7)),
    el('span', '', point.label),
    el('span', 'chip', point.reason),
    el('span', 'muted', `${clockTime(point.createdAt)} · `, ageNode(point.createdAt, now, '')),
  );
}

// The drawer of a card: what the order is, its checks and its checkpoints.
export function mountOrderDetail(host: HTMLElement, store: Store, api: OfficeApi | null, orderId: number, onClose: () => void): OrderDetail {
  const panel = el('aside', 'order-drawer');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('board.drawer.label'));
  const backdrop = el('div', 'order-drawer-backdrop');
  host.replaceChildren(backdrop, panel);
  backdrop.addEventListener('click', onClose);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !document.querySelector('.dialog-backdrop')) onClose();
  };
  document.addEventListener('keydown', onKey);

  let tab: TabName = 'checks';
  let runs: CheckRunView[] = [];
  let points: CheckpointView[] = [];
  let skipped: SkippedFile[] = [];
  let loaded = false;
  let error = '';
  let gone = false;
  let diff: OrderDiff | null = null;
  let diffError = '';
  let diffLoading = false;
  let diffPath: string | null = null;
  let diffFile: OrderDiffFile | null = null;
  let diffFileError = '';
  let diffFileLoading = false;
  let patchCache: { file: OrderDiffFile; lang: string; node: HTMLElement } | null = null;
  let lastSignature = '';
  let lastRun: RunMark | null = null;
  let lastPaint = store.now();

  const order = (): OrderView | undefined => store.orders.find((o) => o.id === orderId);

  const reload = async (): Promise<void> => {
    if (!api) return;
    const [checks, checkpoints] = await Promise.all([api.orderChecks(orderId), api.orderCheckpoints(orderId)]);
    if (gone) return;
    loaded = true;
    if (checks.ok) {
      runs = checks.data.runs;
      error = '';
    } else error = checks.message;
    if (checkpoints.ok) {
      points = checkpoints.data.checkpoints;
      skipped = checkpoints.data.skipped;
    }
    const current = order();
    if (!current || signature(current) !== lastSignature) render();
  };

  const loadDiff = async (): Promise<void> => {
    if (!api || diffLoading) return;
    diffLoading = true;
    diffError = '';
    render();
    const result = await api.orderDiff(orderId);
    if (gone) return;
    diffLoading = false;
    if (result.ok) diff = result.data;
    else diffError = result.message;
    render();
    if (result.ok && diffPath !== null) void loadDiffFile(diffPath);
  };

  const loadDiffFile = async (path: string): Promise<void> => {
    if (!api) return;
    diffPath = path;
    diffFile = null;
    diffFileError = '';
    diffFileLoading = true;
    render();
    const result = await api.orderDiffFile(orderId, path);
    if (gone || diffPath !== path) return;
    diffFileLoading = false;
    if (result.ok) diffFile = result.data;
    else diffFileError = result.message;
    render();
  };

  const act = async (action: () => Promise<{ ok: true } | { ok: false; message: string }>, done?: string): Promise<void> => {
    const result = await action();
    if (!result.ok) store.toast(result.message, 'error');
    else if (done) store.toast(done, 'ok');
  };

  const actions = (current: OrderView): HTMLElement => {
    const row = el('div', 'order-actions');
    if (!api) return row;
    const run = button(t('board.checks.runNow'), 'primary');
    run.disabled = current.checks === null || current.worktree?.state === 'creando';
    run.addEventListener('click', () => void act(async () => {
      const result = await api.runOrderChecks(orderId);
      await reload();
      return result.ok ? { ok: true } : result;
    }));
    row.append(run);
    if (current.checks?.status === 'running') {
      const cancel = button(t('board.checks.cancel'));
      cancel.addEventListener('click', () => void act(async () => {
        const result = await api.cancelOrderChecks(orderId);
        await reload();
        return result.ok ? { ok: true } : result;
      }));
      row.append(cancel);
    }
    if (current.checks && current.checks.touched.length > 0 && !current.checks.forced) {
      const confirm = button(t('board.checks.confirm'));
      confirm.addEventListener('click', () => {
        if (!window.confirm(t('board.checks.confirmAsk', { files: current.checks?.touched.join(', ') ?? '' }))) return;
        void act(async () => {
          const result = await api.confirmOrderChecks(orderId);
          return result.ok ? { ok: true } : result;
        }, t('board.checks.confirmed'));
      });
      row.append(confirm);
    }
    if (current.worktree?.state === 'error') {
      const retry = button(t('board.folder.retry'));
      retry.addEventListener('click', () => void act(async () => {
        const result = await api.retryOrderFolder(orderId);
        return result.ok ? { ok: true } : result;
      }));
      row.append(retry);
    }
    if (current.branch && current.worktree?.path) {
      const draft = button(t('board.pr.open'));
      draft.addEventListener('click', () => openPrDraft(host, store, api, orderId));
      row.append(draft);
    }
    if (current.status !== 'descartado') {
      const discard = button(t('board.discard'), 'doc-discard');
      discard.addEventListener('click', () => {
        if (!window.confirm(t('board.discardAsk', { title: current.title }))) return;
        void act(async () => {
          const result = await api.discardOrder(orderId);
          return result.ok ? { ok: true } : result;
        });
      });
      row.append(discard);
    }
    return row;
  };

  const metaRow = (label: string, value: Node | string | null): HTMLElement | null =>
    value === null || value === '' ? null : el('div', 'order-meta-row', el('span', 'muted', label), typeof value === 'string' ? el('span', '', value) : value);

  const checksTab = (current: OrderView, now: number): HTMLElement => {
    const touched = current.checks && current.checks.touched.length > 0 ? current.checks.touched : [];
    const warning =
      touched.length > 0
        ? el('p', `order-warning${current.checks?.forced ? ' confirmed' : ''}`, t(current.checks?.forced ? 'board.checks.touchedConfirmed' : 'board.checks.touched', { files: touched.join(', ') }))
        : null;
    const live = store.checkRuns.get(orderId);
    const shown = live && !runs.some((r) => r.id === live.id) ? [live, ...runs] : runs.map((r) => (live && r.id === live.id ? live : r));
    const flaky = flakyChecks(shown);
    const body =
      error !== ''
        ? null
        : !loaded && api
          ? el('p', 'muted', t('board.loading'))
          : shown.length === 0
            ? el('p', 'muted', t(current.checks ? 'board.checks.none' : 'board.checks.unconfigured'))
            : el('div', 'runs', ...shown.map((run, index) => runBlock(run, now, index === 0, flaky)));
    const failure = error !== '' ? el('p', 'order-warning', t('board.checks.loadFailed', { error })) : null;
    return el('div', 'order-tab', warning, failure, body);
  };

  const pointsTab = (now: number): HTMLElement => {
    const list = points.length > 0 ? el('ul', 'points-list', ...points.map((p) => pointRow(p, now))) : el('p', 'muted', t(loaded ? 'board.points.none' : 'board.loading'));
    const left =
      skipped.length > 0
        ? el(
            'div',
            'points-skipped',
            el('h4', '', t('board.points.skipped')),
            el('ul', '', ...skipped.map((file) => el('li', '', el('code', '', file.path), ' ', el('span', 'muted', `${kilobytes(file.size)} · ${clockTime(file.mtime)}`)))),
          )
        : null;
    return el('div', 'order-tab', list, left);
  };

  const patchView = (): HTMLElement | null => {
    if (diffPath === null) return el('p', 'muted', t('board.diff.pick'));
    if (diffFileLoading) return el('p', 'muted', t('board.loading'));
    if (diffFileError !== '') return el('p', 'order-warning', t('board.diff.loadFailed', { error: diffFileError }));
    if (!diffFile) return null;
    if (diffFile.binary) return el('p', 'muted', t('board.diff.patchBinary'));
    if (patchCache && patchCache.file === diffFile && patchCache.lang === currentLang()) return patchCache.node;
    const rows = parseDiff(diffFile.patch).flatMap(patchRows);
    const lines = rows.map((row) =>
      el('div', row.className, el('span', 'diff-no', row.oldNo), el('span', 'diff-no', row.newNo), el('span', 'diff-marker', row.marker), el('span', 'diff-text', row.text)),
    );
    const node = el(
      'div',
      'diff-patch-wrap',
      diffFile.truncated ? el('p', 'order-warning', t('board.diff.patchTruncated')) : null,
      lines.length === 0 ? el('p', 'muted', t('board.diff.patchEmpty')) : el('div', 'diff-patch', ...lines),
    );
    patchCache = { file: diffFile, lang: currentLang(), node };
    return node;
  };

  const newestSha = (current: OrderView): string | null => {
    const live = store.checkRuns.get(orderId);
    return latestSha(current, live ? [live, ...runs] : runs, points);
  };

  const diffTab = (current: OrderView): HTMLElement => {
    const reload = button(t('board.diff.reload'));
    reload.disabled = diffLoading || !api;
    reload.addEventListener('click', () => void loadDiff());
    if (diffError !== '') return el('div', 'order-tab', el('p', 'order-warning', t('board.diff.loadFailed', { error: diffError })), el('div', 'order-actions', reload));
    if (!diff) return el('div', 'order-tab', el('p', 'muted', t('board.loading')));
    const rows = statRows(diff).map((row) => {
      const pick = button('', `${row.className}${row.path === diffPath ? ' active' : ''}`);
      pick.append(
        el('span', 'diff-file-path', row.label),
        row.binary ? el('span', 'muted', t('board.diff.binary')) : el('span', 'diff-file-stat', el('span', 'diff-add-count', row.adds), ' ', el('span', 'diff-del-count', row.dels)),
      );
      pick.addEventListener('click', () => void loadDiffFile(row.path));
      return el('li', '', pick);
    });
    const stale = diffStale(diff, current, newestSha(current)) ? button(t('board.diff.stale'), 'order-warning') : null;
    stale?.addEventListener('click', () => void loadDiff());
    return el(
      'div',
      'order-tab',
      el('div', 'diff-head', el('b', '', diffSummary(diff)), reload),
      stale,
      diff.truncated ? el('p', 'order-warning', t('board.diff.truncated')) : null,
      rows.length === 0 ? el('p', 'muted', t('board.diff.none')) : el('ul', 'diff-files', ...rows),
      patchView(),
    );
  };

  const signature = (current: OrderView): string => {
    const floor = store.floorBySlug(current.floor);
    return orderSignature(current, [
      currentLang(),
      tab,
      floor ? floorLabel(floor) : current.floor,
      loaded,
      error,
      store.checkRuns.get(orderId),
      runs,
      points,
      skipped,
      diff?.head ?? null,
      diffError,
      diffLoading,
      diffPath,
      diffFileLoading,
      diffFileError,
    ]);
  };

  function render(): void {
    const current = order();
    if (!current) {
      panel.replaceChildren(el('p', 'muted', t('board.gone')));
      return;
    }
    const now = store.now();
    const hasFolder = current.branch !== null || current.worktree !== null;
    if (tab === 'diff' && !hasFolder) tab = 'checks';
    lastSignature = signature(current);
    const floor = store.floorBySlug(current.floor);
    const close = button('×', 'order-close');
    close.setAttribute('aria-label', t('board.drawer.close'));
    close.addEventListener('click', onClose);
    const tabs = el('div', 'order-tabs');
    for (const name of hasFolder ? (['checks', 'points', 'diff'] as const) : (['checks', 'points'] as const)) {
      const tabButton = button(t(`board.tab.${name}`), `order-tab-button${tab === name ? ' active' : ''}`);
      tabButton.setAttribute('aria-selected', String(tab === name));
      tabButton.addEventListener('click', () => {
        tab = name;
        if (name === 'diff' && !diff && !diffLoading) void loadDiff();
        else render();
      });
      tabs.append(tabButton);
    }
    const parts: (Node | null)[] = [
      el('header', 'order-head', el('h3', 'order-title', current.title), close),
      el(
        'div',
        'order-meta',
        metaRow(t('board.drawer.status'), t(`board.col.${current.status}`)),
        metaRow(t('board.drawer.floor'), floor ? floorLabel(floor) : current.floor),
        metaRow(t('board.drawer.cycle'), current.cycle > 1 ? String(current.cycle) : null),
        metaRow(t('board.drawer.lead'), current.lead),
        metaRow(t('board.drawer.branch'), current.branch ? el('code', '', current.branch) : null),
        metaRow(t('board.drawer.base'), current.base ? el('code', '', `${current.base}${current.baseSha ? `@${current.baseSha.slice(0, 7)}` : ''}`) : null),
        metaRow(t('board.drawer.folder'), current.worktree?.path ? el('code', 'order-path', current.worktree.path) : null),
        metaRow(t('board.drawer.state'), folderBadgeNode(current)),
        metaRow(t('board.drawer.checks'), checksBadgeNode(current)),
        metaRow(t('board.drawer.plan'), current.planSlug),
      ),
      current.worktree?.error ? el('pre', 'order-error', current.worktree.error) : null,
      current.description ? el('p', 'order-description', current.description) : null,
      actions(current),
      tabs,
      tab === 'checks' ? checksTab(current, now) : tab === 'points' ? pointsTab(now) : diffTab(current),
    ];
    panel.replaceChildren(...parts.filter((part): part is Node => part !== null));
  }

  const noteRun = (): void => {
    const run = store.checkRuns.get(orderId);
    lastRun = run ? { id: run.id, status: run.status } : lastRun;
  };
  const unwatch = store.watch(['orders', 'checks', 'lang'], () => {
    const current = order();
    if (!current) return;
    if (signature(current) !== lastSignature) render();
  });
  const unwatchChecks = store.watch(['checks'], () => {
    const run = store.checkRuns.get(orderId);
    if (!api || !shouldReloadForChecks(run, lastRun)) return;
    noteRun();
    void reload();
  });
  const unwatchTick = store.watch(['tick'], () => {
    const now = store.now();
    if (now - lastPaint < AGE_REPAINT_MS) return;
    lastPaint = now;
    for (const node of panel.querySelectorAll<HTMLElement>('time[data-ts]')) node.textContent = relativeTime(Number(node.dataset.ts), now);
  });
  noteRun();
  void reload();
  render();

  return {
    destroy() {
      gone = true;
      unwatch();
      unwatchChecks();
      unwatchTick();
      document.removeEventListener('keydown', onKey);
    },
  };
}
