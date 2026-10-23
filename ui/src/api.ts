import { type Lang, t } from './i18n';
import { errorText } from './i18n/hub';
import type {
  AnswerRequest,
  ChatMessageView,
  ChatUserResult,
  CheckRunView,
  CheckpointView,
  OrderDiff,
  OrderDiffFile,
  DocumentContent,
  FloorAddRequest,
  FloorAddResult,
  FloorRemoveResult,
  LayoutsFile,
  LessonCreate,
  LessonView,
  MemoryView,
  OrderRequest,
  OrderStatus,
  OrderView,
  PlanDecision,
  ReportView,
  RoleId,
  SearchResult,
  SettingsResult,
  SettingsUpdate,
  SettingsView,
  SkippedFile,
  UsageRange,
  OfficeDigest,
  UsageSummary,
  WorktreeView,
} from './types';

export type NewOrderRequest = { floor: string; title: string; description?: string; base?: string; via: 'lead' | 'director' };

// key: the dictionary key of the hub error when it sent one, for the callers that act on a particular failure.
export type ApiResult = { ok: true } | { ok: false; status: number; message: string; key?: string };

export type ApiData<T> = { ok: true; data: T } | { ok: false; status: number; message: string; key?: string };

async function readError(response: Response): Promise<{ message: string; key?: string }> {
  const fallback = { message: t('api.error', { status: response.status }) };
  let raw: string;
  try {
    raw = (await response.text()).trim();
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const field of ['error', 'message']) {
        const value = record[field];
        if (value === undefined || value === '') continue;
        const text = errorText(t, value);
        if (text) {
          const key = typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string' ? (value as { key: string }).key : undefined;
          return key ? { message: text, key } : { message: text };
        }
      }
    }
  } catch {
    return { message: raw };
  }
  return { message: raw };
}

export class OfficeApi {
  constructor(
    private readonly token: string,
    private readonly onDenied: () => void = () => {},
  ) {}

  answer(id: string, request: AnswerRequest): Promise<ApiResult> {
    return this.post(`/api/answers/${encodeURIComponent(id)}`, request, {
      409: t('api.alreadyAnswered'),
    });
  }

  order(request: OrderRequest): Promise<ApiResult> {
    return this.post('/api/orders', request, {
      404: t('api.sessionNotFound'),
      502: t('api.orderFailed'),
    });
  }

  requestStatus(sessionId: string): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', `/api/sessions/${encodeURIComponent(sessionId)}/status`, {});
  }

  relaunch(sessionId: string): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', `/api/sessions/${encodeURIComponent(sessionId)}/relaunch`, {});
  }

  settings(): Promise<ApiData<SettingsView>> {
    return this.get('/api/settings');
  }

  saveSettings(update: SettingsUpdate): Promise<ApiData<SettingsResult>> {
    return this.send('POST', '/api/settings', update);
  }

  saveLayouts(file: LayoutsFile): Promise<ApiData<{ ok: true; data: LayoutsFile }>> {
    return this.send('PUT', '/api/layouts', file);
  }

  memory(floor: string, role: RoleId): Promise<ApiData<MemoryView>> {
    return this.get(`/api/memory/${encodeURIComponent(floor)}/${encodeURIComponent(role)}`);
  }

  addLesson(lesson: LessonCreate): Promise<ApiData<{ lesson: LessonView }>> {
    return this.send('POST', '/api/memory', lesson);
  }

  editLesson(id: number, text: string): Promise<ApiData<{ lesson: LessonView }>> {
    return this.send('PUT', `/api/memory/${id}`, { text });
  }

  deleteLesson(id: number): Promise<ApiData<{ ok: true }>> {
    return this.send('DELETE', `/api/memory/${id}`, undefined);
  }

  report(agentKey: string): Promise<ApiData<ReportView>> {
    return this.get(`/api/reports/${encodeURIComponent(agentKey)}`);
  }

  usageSummary(range: UsageRange): Promise<ApiData<UsageSummary>> {
    return this.get(`/api/usage/summary?range=${range}`);
  }

  digest(day: string): Promise<ApiData<OfficeDigest>> {
    return this.get(`/api/digest?day=${encodeURIComponent(day)}`);
  }

  documentContent(path: string): Promise<ApiData<DocumentContent>> {
    return this.get(`/api/documents/content?path=${encodeURIComponent(path)}`);
  }

  discardDocument(path: string): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', '/api/documents/discard', { path });
  }

  restoreDocument(path: string): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', '/api/documents/restore', { path });
  }

  decidePlan(path: string, decision: PlanDecision): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', '/api/documents/decide', { path, decision });
  }

  addFloor(request: FloorAddRequest): Promise<ApiData<Extract<FloorAddResult, { ok: true }>>> {
    return this.send('POST', '/api/floors', request);
  }

  deleteFloor(slug: string, force = false): Promise<ApiData<Extract<FloorRemoveResult, { ok: true }>>> {
    return this.send('DELETE', `/api/floors/${encodeURIComponent(slug)}${force ? '?force=1' : ''}`, undefined);
  }

  board(): Promise<ApiData<{ orders: OrderView[] }>> {
    return this.get('/api/board');
  }

  createOrder(request: NewOrderRequest): Promise<ApiData<{ order: OrderView }>> {
    return this.send('POST', '/api/board/orders', request);
  }

  moveOrder(id: number, to: OrderStatus, force = false): Promise<ApiData<{ order: OrderView }>> {
    return this.send('POST', `/api/board/orders/${id}/move`, { to, force });
  }

  discardOrder(id: number): Promise<ApiData<{ order: OrderView }>> {
    return this.send('POST', `/api/board/orders/${id}/discard`, {});
  }

  retryOrderFolder(id: number): Promise<ApiData<{ order: OrderView }>> {
    return this.send('POST', `/api/board/orders/${id}/folder`, {});
  }

  confirmOrderChecks(id: number): Promise<ApiData<{ order: OrderView }>> {
    return this.send('POST', `/api/board/orders/${id}/confirm-checks`, {});
  }

  orderChecks(id: number): Promise<ApiData<{ latest: CheckRunView | null; runs: CheckRunView[] }>> {
    return this.get(`/api/board/orders/${id}/checks`);
  }

  runOrderChecks(id: number): Promise<ApiData<{ run: CheckRunView }>> {
    return this.send('POST', `/api/board/orders/${id}/checks`, {});
  }

  cancelOrderChecks(id: number): Promise<ApiData<{ ok: true; cancelled: boolean }>> {
    return this.send('DELETE', `/api/board/orders/${id}/checks`, undefined);
  }

  orderCheckpoints(id: number): Promise<ApiData<{ checkpoints: CheckpointView[]; skipped: SkippedFile[] }>> {
    return this.get(`/api/board/orders/${id}/checkpoints`);
  }

  orderDiff(id: number): Promise<ApiData<OrderDiff>> {
    return this.get(`/api/board/orders/${id}/diff`);
  }

  orderDiffFile(id: number, path: string): Promise<ApiData<OrderDiffFile>> {
    return this.get(`/api/board/orders/${id}/diff/file?path=${encodeURIComponent(path)}`);
  }

  orderPrDraft(id: number, lang: Lang): Promise<ApiData<{ title: string; body: string }>> {
    return this.get(`/api/board/orders/${id}/pr-draft?lang=${lang}`);
  }

  markFinishedSeen(id: number): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', `/api/alerts/${id}/seen`, {});
  }

  worktrees(floor?: string): Promise<ApiData<{ worktrees: WorktreeView[]; totalKb: number; warnKb: number }>> {
    return this.get(`/api/worktrees${floor ? `?floor=${encodeURIComponent(floor)}` : ''}`);
  }

  removeWorktree(orderId: number, opts: { branch: boolean; force: boolean }): Promise<ApiData<{ ok: true }>> {
    const query = [opts.branch ? 'branch=1' : '', opts.force ? 'force=1' : ''].filter(Boolean).join('&');
    return this.send('DELETE', `/api/worktrees/${orderId}${query ? `?${query}` : ''}`, undefined);
  }

  keepWorktree(orderId: number): Promise<ApiData<{ ok: true }>> {
    return this.send('POST', `/api/worktrees/${orderId}/keep`, {});
  }

  pruneWorktrees(): Promise<ApiData<{ removed: number }>> {
    return this.send('POST', '/api/worktrees/prune', {});
  }

  // path comes from searchPath() in table/history.ts.
  search(path: string): Promise<ApiData<SearchResult>> {
    return this.get(path);
  }

  chatHistory(channel: string, before: number | null): Promise<ApiData<ChatMessageView[]>> {
    const query = before === null ? '' : `?before=${before}`;
    return this.get(`/api/chat/${encodeURIComponent(channel)}${query}`);
  }

  postChat(channel: string, text: string): Promise<ApiData<ChatUserResult>> {
    return this.send('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
  }

  private get<T>(path: string): Promise<ApiData<T>> {
    return this.send('GET', path, undefined);
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<ApiData<T>> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Office-Panel': this.token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0, message: t('api.offline') };
    }
    if (response.status === 401) this.onDenied();
    if (!response.ok) return { ok: false, status: response.status, ...(await readError(response)) };
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch {
      return { ok: false, status: response.status, message: t('api.badResponse') };
    }
  }

  private async post(path: string, body: unknown, fixed: Record<number, string>): Promise<ApiResult> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Office-Panel': this.token },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0, message: t('api.offline') };
    }
    if (response.ok) return { ok: true };
    if (response.status === 401) this.onDenied();
    const failure = await readError(response);
    return { ok: false, status: response.status, ...failure, message: fixed[response.status] ?? failure.message };
  }
}
