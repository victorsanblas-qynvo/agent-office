import type { OfficeApi } from '../api';
import { button, el } from '../dom';
import { currentLang, plural, t } from '../i18n';
import { renderHubText } from '../i18n/hub';
import { agentName, floorLabel } from '../labels';
import type { Store } from '../store';
import { clockTime, relativeTime } from '../time';
import type { CheckRunView, CheckView, CheckpointView, OrderCommentView, OrderDiff, OrderDiffFile, OrderView, SearchHit, SkippedFile } from '../types';
import { activityPath, activityTerms, orderTimeline } from './activity-model';
import { checksBadgeNode, folderBadgeNode } from './badges';
import { flakyChecks } from './flaky';
import { diffStale, diffSummary, firstChangedLine, latestSha, orderSignature, patchRows, shouldReloadForChecks, statRows } from './diff-model';
import type { RunMark } from './diff-model';
import { parseDiff } from './diff-parse';
import { editorLink } from './editor-link';
import { readEditor } from '../prefs';
import { REVIEW_MAX_BODY } from '../../../shared/review-message';
import { openPrDraft } from './pr-draft';
import { canRestore, pointNumbers } from './points-model';
import { openReviewDialog } from './review-dialog';
import {
  addDraft,
  commentsAt,
  draftsAt,
  draftsFull,
  draftsIn,
  fileComments,
  fileTarget,
  removeDraft,
  reviewReopens,
  reviewRequest,
  rowTarget,
  sameTarget,
  targetKey,
  targetLabel,
  unsentCount,
  type ReviewDraft,
  type ReviewTarget,
} from './review-model';

export type OrderDetail = { destroy(): void };

type TabName = 'checks' | 'points' | 'activity' | 'diff';

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

function pointRow(point: CheckpointView, n: number | undefined, now: number, actions: HTMLElement | null): HTMLElement {
  return el(
    'li',
    'point-row',
    n !== undefined ? el('span', 'muted', `#${n}`) : null,
    el('code', '', point.sha.slice(0, 7)),
    el('span', '', point.label),
    el('span', 'chip', point.reason),
    el('span', 'muted', `${clockTime(point.createdAt)} · `, ageNode(point.createdAt, now, '')),
    actions,
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
  let restored: { safetyRef: string; n: number } | null = null;
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
  let patchCache: { file: OrderDiffFile; lang: string; root: string; review: number; node: HTMLElement } | null = null;
  let drafts: ReviewDraft[] = [];
  let comments: OrderCommentView[] = [];
  let editing: ReviewTarget | null = null;
  let editText = '';
  let focusEditor = false;
  let reviewStamp = 0;
  let resending = false;
  let activityHits: SearchHit[] = [];
  let activityLoaded = false;
  let activityLoading = false;
  let activityError = '';
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
    if (activityLoaded) void loadActivity();
    if (!current || signature(current) !== lastSignature) render();
  };

  const loadActivity = async (): Promise<void> => {
    const current = order();
    if (!api || !current || activityLoading) return;
    activityLoading = true;
    activityError = '';
    render();
    const results = await Promise.all(activityTerms(current).map((term) => api.search(activityPath(current, term))));
    if (gone) return;
    activityLoading = false;
    activityLoaded = true;
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) activityError = failed.message;
    activityHits = results.flatMap((result) => (result.ok ? result.data.hits : []));
    render();
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
    if (result.ok) void loadComments();
    if (result.ok && diffPath !== null) void loadDiffFile(diffPath);
  };

  const loadComments = async (): Promise<void> => {
    if (!api) return;
    const result = await api.orderComments(orderId);
    if (gone || !result.ok) return;
    comments = result.data.comments;
    reviewStamp += 1;
    render();
  };

  const reviewChanged = (): void => {
    reviewStamp += 1;
    render();
  };

  const sendReview = async (summary: string): Promise<boolean> => {
    if (!api) return false;
    const result = await api.sendReview(orderId, reviewRequest(drafts, summary, currentLang()));
    if (gone) return true;
    if (!result.ok) {
      store.toast(result.message, 'error');
      return false;
    }
    drafts = [];
    if (result.data.delivered) store.toast(plural('board.review.sent', result.data.count), 'ok');
    else store.toast(renderHubText(t, result.data.reason), 'error');
    reviewChanged();
    await loadComments();
    return true;
  };

  // The comments the lead did not get stay stored: they go again in one message, never twice.
  const resendReview = async (): Promise<void> => {
    if (!api || resending) return;
    resending = true;
    reviewChanged();
    const result = await api.resendReview(orderId, currentLang());
    resending = false;
    if (gone) return;
    if (!result.ok) store.toast(result.message, 'error');
    else if (result.data.delivered) store.toast(plural('board.review.sent', result.data.count), 'ok');
    else store.toast(renderHubText(t, result.data.reason), 'error');
    reviewChanged();
    await loadComments();
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

  const restorePoint = (point: CheckpointView, n: number): void => {
    if (!api || !window.confirm(t('board.points.restoreAsk', { n, sha: point.sha.slice(0, 7) }))) return;
    void act(async () => {
      const result = await api.resetToCheckpoint(orderId, point.id);
      if (result.ok) restored = { safetyRef: result.data.safetyRef, n };
      await reload();
      return result.ok ? { ok: true } : result;
    }, t('board.points.restored', { n }));
  };

  const undoRestore = (): void => {
    const last = restored;
    if (!api || !last) return;
    void act(async () => {
      const result = await api.undoCheckpointReset(orderId, last.safetyRef);
      if (result.ok) restored = null;
      await reload();
      return result.ok ? { ok: true } : result;
    }, t('board.points.undone'));
  };

  const forkPoint = (point: CheckpointView, n: number): void => {
    if (!api || !window.confirm(t('board.points.forkAsk', { n, sha: point.sha.slice(0, 7) }))) return;
    void (async () => {
      const result = await api.forkFromCheckpoint(orderId, point.id);
      if (!result.ok) store.toast(result.message, 'error');
      else store.toast(t('board.points.forked', { title: result.data.order.title }), 'ok');
    })();
  };

  const pointActions = (current: OrderView, point: CheckpointView, n: number | undefined): HTMLElement | null => {
    if (!api || n === undefined) return null;
    const restore = button(t('board.points.restore'), '', canRestore(current) ? '' : t('board.points.restoreBlocked'));
    restore.disabled = !canRestore(current);
    restore.addEventListener('click', () => restorePoint(point, n));
    const fork = button(t('board.points.fork'));
    fork.addEventListener('click', () => forkPoint(point, n));
    return el('span', 'point-actions', restore, fork);
  };

  const pointsTab = (current: OrderView, now: number): HTMLElement => {
    const numbers = pointNumbers(points);
    const list =
      points.length > 0
        ? el('ul', 'points-list', ...points.map((p) => pointRow(p, numbers.get(p.id), now, pointActions(current, p, numbers.get(p.id)))))
        : el('p', 'muted', t(loaded ? 'board.points.none' : 'board.loading'));
    const undo = restored ? button(t('board.points.undo')) : null;
    undo?.addEventListener('click', undoRestore);
    const banner = restored ? el('div', 'order-warning points-restored', el('span', '', t('board.points.undoBanner', { n: restored.n, ref: restored.safetyRef })), undo) : null;
    const left =
      skipped.length > 0
        ? el(
            'div',
            'points-skipped',
            el('h4', '', t('board.points.skipped')),
            el('ul', '', ...skipped.map((file) => el('li', '', el('code', '', file.path), ' ', el('span', 'muted', `${kilobytes(file.size)} · ${clockTime(file.mtime)}`)))),
          )
        : null;
    return el('div', 'order-tab', banner, list, left);
  };

  const activityTab = (current: OrderView, now: number): HTMLElement => {
    const reload = button(t('board.activity.reload'));
    reload.disabled = activityLoading || !api;
    reload.addEventListener('click', () => void loadActivity());
    const live = store.checkRuns.get(orderId);
    const shown = live && !runs.some((r) => r.id === live.id) ? [live, ...runs] : runs.map((r) => (live && r.id === live.id ? live : r));
    const rows = orderTimeline(activityHits, shown, points, current, (key) => {
      const known = store.agents.get(key);
      return known ? agentName(known) : key;
    });
    const body = activityLoading && !activityLoaded
      ? el('p', 'muted', t('board.loading'))
      : rows.length === 0
        ? el('p', 'muted', t('board.activity.none'))
        : el(
            'ul',
            'activity-list',
            ...rows.map((row) =>
              el(
                'li',
                `activity-row activity-${row.kind}`,
                ageNode(row.ts, now),
                el('span', 'chip', t(`board.activity.kind.${row.kind}`)),
                row.who ? el('b', '', row.who) : null,
                el('span', 'activity-text', row.text),
              ),
            ),
          );
    return el(
      'div',
      'order-tab',
      activityError !== '' ? el('p', 'order-warning', t('board.activity.loadFailed', { error: activityError })) : null,
      el('div', 'order-actions', reload),
      body,
    );
  };

  const openLink = (root: string | null, path: string, line?: number, label = t('board.diff.open')): HTMLAnchorElement | null => {
    const href = root === null ? null : editorLink(readEditor(), root, path, line);
    if (href === null) return null;
    const link = el('a', 'diff-open', label);
    link.href = href;
    link.rel = 'noreferrer';
    return link;
  };

  const startComment = (target: ReviewTarget): void => {
    if (draftsFull(drafts)) {
      store.toast(t('board.review.full', { n: drafts.length }), 'error');
      return;
    }
    editing = target;
    editText = '';
    focusEditor = true;
    reviewChanged();
  };

  const commentButton = (target: ReviewTarget): HTMLButtonElement => {
    const label = t('board.review.commentLine', { line: target.line ?? '' });
    const node = button('+', 'diff-comment', label);
    node.setAttribute('aria-label', label);
    node.addEventListener('click', () => startComment(target));
    return node;
  };

  const editor = (target: ReviewTarget): HTMLElement => {
    const area = el('textarea', 'review-input');
    area.rows = 3;
    area.maxLength = REVIEW_MAX_BODY;
    area.value = editText;
    area.placeholder = t('board.review.placeholder');
    area.setAttribute('aria-label', targetLabel(target));
    area.addEventListener('input', () => {
      editText = area.value;
    });
    const add = button(t('board.review.add'), 'primary');
    add.addEventListener('click', () => {
      if (area.value.trim() === '') return;
      drafts = addDraft(drafts, target, area.value);
      editing = null;
      editText = '';
      reviewChanged();
    });
    const cancel = button(t('board.review.cancel'));
    cancel.addEventListener('click', () => {
      editing = null;
      editText = '';
      reviewChanged();
    });
    return el('div', 'review-editor', area, el('div', 'new-order-actions', cancel, add));
  };

  const pastNote = (comment: OrderCommentView, now: number, located: boolean): HTMLElement =>
    el(
      'div',
      'review-note review-past',
      el(
        'div',
        'review-note-head',
        located ? el('code', '', targetLabel(comment)) : null,
        comment.cycle !== null ? el('span', 'chip', t('board.review.cycle', { cycle: comment.cycle })) : null,
        comment.sentAt === null ? el('span', 'chip review-unsent', t('board.review.unsent')) : null,
        ageNode(comment.createdAt, now),
      ),
      el('span', 'review-body', comment.body),
    );

  const draftNote = (draft: ReviewDraft): HTMLElement => {
    const remove = button(t('board.review.remove'), 'review-remove');
    remove.addEventListener('click', () => {
      drafts = removeDraft(drafts, draft.id);
      reviewChanged();
    });
    return el('div', 'review-note review-draft', el('span', 'chip', t('board.review.draft')), el('span', 'review-body', draft.body), remove);
  };

  const thread = (target: ReviewTarget, now: number): HTMLElement | null => {
    const parts = [
      ...commentsAt(comments, target).map((comment) => pastNote(comment, now, false)),
      ...draftsAt(drafts, target).map(draftNote),
      editing && sameTarget(editing, target) ? editor(target) : null,
    ].filter((part): part is HTMLElement => part !== null);
    return parts.length > 0 ? el('div', 'review-thread', ...parts) : null;
  };

  const fileReview = (path: string, shown: ReadonlySet<string>, now: number): HTMLElement | null => {
    if (!api) return null;
    const target = fileTarget(path);
    const start = button(t('board.review.commentFile'), 'review-file-button');
    start.addEventListener('click', () => startComment(target));
    const others = fileComments(comments, path, shown).filter((comment) => comment.line !== null);
    return el(
      'div',
      'review-file',
      start,
      thread(target, now),
      others.length > 0 ? el('div', 'review-thread', ...others.map((comment) => pastNote(comment, now, true))) : null,
    );
  };

  const patchView = (root: string | null): HTMLElement | null => {
    if (diffPath === null) return el('p', 'muted', t('board.diff.pick'));
    if (diffFileLoading) return el('p', 'muted', t('board.loading'));
    if (diffFileError !== '') return el('p', 'order-warning', t('board.diff.loadFailed', { error: diffFileError }));
    if (!diffFile) return null;
    const now = store.now();
    if (diffFile.binary) return el('div', 'diff-patch-wrap', fileReview(diffFile.path, new Set(), now), el('p', 'muted', t('board.diff.patchBinary')));
    const linkKey = `${root ?? ''}|${readEditor()}`;
    if (patchCache && patchCache.file === diffFile && patchCache.lang === currentLang() && patchCache.root === linkKey && patchCache.review === reviewStamp) return patchCache.node;
    const rows = parseDiff(diffFile.patch).flatMap(patchRows);
    const filePath = diffFile.path;
    const shown = new Set<string>();
    const lines = rows.flatMap((row) => {
      const link = row.newLine === null ? null : openLink(root, filePath, row.newLine, row.newNo);
      const newNo = el('span', 'diff-no', link ?? row.newNo);
      const target = rowTarget(filePath, row);
      if (target) shown.add(targetKey(target));
      const comment = target && api ? commentButton(target) : null;
      const line = el('div', row.className, el('span', 'diff-no', row.oldNo), newNo, el('span', 'diff-gutter', comment), el('span', 'diff-marker', row.marker), el('span', 'diff-text', row.text));
      const notes = target ? thread(target, now) : null;
      return notes ? [line, notes] : [line];
    });
    const node = el(
      'div',
      'diff-patch-wrap',
      fileReview(filePath, shown, now),
      diffFile.truncated ? el('p', 'order-warning', t('board.diff.patchTruncated')) : null,
      lines.length === 0 ? el('p', 'muted', t('board.diff.patchEmpty')) : el('div', 'diff-patch', ...lines),
    );
    patchCache = { file: diffFile, lang: currentLang(), root: linkKey, review: reviewStamp, node };
    return node;
  };

  const newestSha = (current: OrderView): string | null => {
    const live = store.checkRuns.get(orderId);
    return latestSha(current, live ? [live, ...runs] : runs, points);
  };

  const unsentBar = (): HTMLElement | null => {
    const unsent = unsentCount(comments);
    if (!api || unsent === 0) return null;
    const resend = button(t('board.review.resend'), '', plural('board.review.resendLabel', unsent));
    resend.disabled = resending;
    resend.addEventListener('click', () => void resendReview());
    return el('span', 'review-unsent-bar', el('span', 'review-unsent', plural('board.review.unsentCount', unsent)), ' · ', resend);
  };

  const diffTab = (current: OrderView): HTMLElement => {
    const reload = button(t('board.diff.reload'));
    reload.disabled = diffLoading || !api;
    reload.addEventListener('click', () => void loadDiff());
    if (diffError !== '') return el('div', 'order-tab', el('p', 'order-warning', t('board.diff.loadFailed', { error: diffError })), el('div', 'order-actions', reload));
    if (!diff) return el('div', 'order-tab', el('p', 'muted', t('board.loading')));
    const root = current.worktree?.path ?? null;
    const rows = statRows(diff).map((row) => {
      const pick = button('', `${row.className}${row.path === diffPath ? ' active' : ''}`);
      const pending = draftsIn(drafts, row.path);
      pick.append(el('span', 'diff-file-path', row.label));
      if (pending > 0) pick.append(el('span', 'chip review-count', plural('board.review.drafts', pending)));
      pick.append(
        row.binary ? el('span', 'muted', t('board.diff.binary')) : el('span', 'diff-file-stat', el('span', 'diff-add-count', row.adds), ' ', el('span', 'diff-del-count', row.dels)),
      );
      pick.addEventListener('click', () => void loadDiffFile(row.path));
      const line = row.path === diffPath && diffFile ? firstChangedLine(parseDiff(diffFile.patch)) : 1;
      return el('li', 'diff-file-item', pick, row.binary ? null : openLink(root, row.path, line));
    });
    const stale = diffStale(diff, current, newestSha(current)) ? button(t('board.diff.stale'), 'order-warning') : null;
    stale?.addEventListener('click', () => void loadDiff());
    const send = api ? button(t('board.review.send', { n: drafts.length }), 'primary') : null;
    if (send) {
      send.disabled = drafts.length === 0;
      send.addEventListener('click', () =>
        openReviewDialog(host, {
          slug: current.slug,
          note: reviewReopens(current.status) ? t('board.review.reopens') : null,
          drafts: () => drafts,
          remove: (id) => {
            drafts = removeDraft(drafts, id);
            reviewChanged();
          },
          send: sendReview,
        }),
      );
    }
    return el(
      'div',
      'order-tab',
      el('div', 'diff-head', el('b', '', diffSummary(diff)), unsentBar(), send, reload),
      stale,
      diff.truncated ? el('p', 'order-warning', t('board.diff.truncated')) : null,
      rows.length === 0 ? el('p', 'muted', t('board.diff.none')) : el('ul', 'diff-files', ...rows),
      patchView(root),
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
      restored,
      activityHits,
      activityLoaded,
      activityLoading,
      activityError,
      diff?.head ?? null,
      diffError,
      diffLoading,
      diffPath,
      diffFileLoading,
      diffFileError,
      reviewStamp,
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
    for (const name of hasFolder ? (['checks', 'points', 'activity', 'diff'] as const) : (['checks', 'points', 'activity'] as const)) {
      const tabButton = button(t(`board.tab.${name}`), `order-tab-button${tab === name ? ' active' : ''}`);
      tabButton.setAttribute('aria-selected', String(tab === name));
      tabButton.addEventListener('click', () => {
        tab = name;
        if (name === 'diff' && !diff && !diffLoading) void loadDiff();
        else if (name === 'activity' && !activityLoaded && !activityLoading) void loadActivity();
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
      tab === 'checks' ? checksTab(current, now) : tab === 'points' ? pointsTab(current, now) : tab === 'activity' ? activityTab(current, now) : diffTab(current),
    ];
    const typing = document.activeElement instanceof HTMLTextAreaElement && panel.contains(document.activeElement) ? document.activeElement : null;
    panel.replaceChildren(...parts.filter((part): part is Node => part !== null));
    const input = panel.querySelector<HTMLTextAreaElement>('.review-input');
    if (focusEditor && input) input.focus();
    else if (typing?.isConnected) typing.focus();
    focusEditor = false;
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
