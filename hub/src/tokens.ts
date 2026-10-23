import type { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { agentContext, contextOf, isCompaction, windowFor as defaultWindow } from './context';
import { realPath } from './floors';
import type { AgentContext, FloorKind, RoleId, TokenRow, TokenTotals, TokensEvent, UsageDay, UsageRange, UsageSummary } from './types';

export type TokenCursor = {
  transcript: string;
  offset: number;
  lastMsgId: string | null;
  lastOut: number;
  skipped: number;
  // Tokens the last turn held in the window, and the compactions seen in this transcript.
  lastContext: number | null;
  compactions: number;
};

export type TokenDelta = { day: string; model: string; tokens: TokenTotals };

export type ChunkResult = {
  consumed: number;
  deltas: TokenDelta[];
  lastMsgId: string | null;
  lastOut: number;
  skipped: number;
  lastContext: number | null;
  compactions: number;
  lastModel: string | null;
};

export type MeterAgent = {
  key: string;
  sessionId: string;
  floor: string;
  roleId: RoleId | null;
  name: string | null;
  cwd: string | null;
  plan: string | null;
};

export type PlanSubject = { name: string | null; roleId: RoleId | null; floorKind: FloorKind; planSlug: string | null };

export const MAX_LINE = 4 * 1024 * 1024;
export const MAX_LINE_READ = 16 * 1024 * 1024;
export const MAX_FILE = 200 * 1024 * 1024;
export const READ_BUDGET = 2 * 1024 * 1024;
export const READ_CHUNK = 1024 * 1024;
const MIN_CHUNK = 64 * 1024;
export const SWEEP_BUDGET = 16 * 1024 * 1024;
const SWEEP_MISS_MS = 60_000;
const LF = 0x0a;
const PLAN_PATH = /redaccion\/planes\/([a-z0-9][a-z0-9_-]{0,79})\.md/;
const ORDER_REF = /(?<![\w/])encargo\/([a-z0-9][a-z0-9-]{0,60})(?![\w-])/;
const WRITER_NAME = /^redactor-([a-z0-9][a-z0-9_-]{0,79})$/;
const REVIEWER_NAME = /^revisor-planes-([a-z0-9][a-z0-9_-]{0,79}?)-r\d+$/;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const EMPTY: TokenTotals = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };

type Subject = { agent: MeterAgent; plan: string | null };

type CursorRow = {
  transcript: string;
  byte_offset: number;
  last_msg_id: string | null;
  last_out: number;
  skipped_lines: number;
  last_context: number | null;
  compactions: number | null;
};

type TotalsRow = { turns: number; input: number; cache_read: number; cache_create: number; output: number };

export function zeroTotals(): TokenTotals {
  return { ...EMPTY };
}

export function addTotals(into: TokenTotals, add: TokenTotals): void {
  into.turns += add.turns;
  into.input += add.input;
  into.cacheRead += add.cacheRead;
  into.cacheCreate += add.cacheCreate;
  into.output += add.output;
}

export function grandTotal(t: TokenTotals): number {
  return t.input + t.cacheRead + t.cacheCreate + t.output;
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function localDay(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The slug of the plan whose path the text names, and nothing else.
export function planDocSlugIn(body: string | null | undefined): string | null {
  return body ? (PLAN_PATH.exec(body)?.[1] ?? null) : null;
}

// A plan path gives the slug of the plan; encargo/<slug> gives the order, labelled with its branch name so it
// never collides with the slug of a plan.
export function planSlugIn(body: string | null | undefined): string | null {
  if (!body) return null;
  const plan = PLAN_PATH.exec(body)?.[1];
  if (plan) return plan;
  const order = ORDER_REF.exec(body)?.[1];
  return order ? `encargo/${order}` : null;
}

export function planSlugOf(agent: PlanSubject, lead: PlanSubject | null): string | null {
  switch (agent.roleId) {
    case 'redactor':
      return WRITER_NAME.exec(agent.name ?? '')?.[1] ?? null;
    case 'revisor-planes':
      return REVIEWER_NAME.exec(agent.name ?? '')?.[1] ?? null;
    case 'lead':
      return agent.floorKind === 'managed' ? agent.planSlug : null;
    case 'dev':
    case 'tester':
    case 'reviewer':
      return agent.planSlug ?? (lead ? planSlugOf(lead, null) : null);
    default:
      return null;
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseChunk(
  buf: Uint8Array,
  cursor: Pick<TokenCursor, 'lastMsgId' | 'lastOut'> & { lastContext?: number | null },
  now: number,
): ChunkResult {
  const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = bytes.lastIndexOf(LF);
  const rows = new Map<string, TokenDelta>();
  let lastMsgId = cursor.lastMsgId;
  let lastOut = cursor.lastOut;
  let lastContext = cursor.lastContext ?? null;
  let lastModel: string | null = null;
  let compactions = 0;
  let skipped = 0;
  if (end < 0) return { consumed: 0, deltas: [], lastMsgId, lastOut, skipped, lastContext, compactions, lastModel };

  let start = 0;
  while (start <= end) {
    const next = bytes.indexOf(LF, start);
    const stop = next < 0 || next > end ? end : next;
    if (stop - start > MAX_LINE) {
      skipped += 1;
    } else if (stop > start) {
      const line = bytes.toString('utf8', start, stop);
      const boundary = compactBoundary(line);
      const parsed = boundary ? null : lineUsage(line);
      if (boundary) {
        compactions += 1;
        lastContext = boundary.postTokens;
      }
      if (parsed) {
        lastModel = parsed.model || lastModel;
        const day = parsed.timestamp === null ? localDay(now) : localDay(parsed.timestamp);
        const key = `${day}\n${parsed.model}`;
        const row = rows.get(key) ?? { day, model: parsed.model, tokens: zeroTotals() };
        rows.set(key, row);
        if (parsed.id === lastMsgId) {
          row.tokens.output += Math.max(0, parsed.output - lastOut);
          lastOut = Math.max(lastOut, parsed.output);
          if (parsed.context > 0) lastContext = parsed.context;
        } else {
          row.tokens.turns += 1;
          row.tokens.input += parsed.input;
          row.tokens.cacheRead += parsed.cacheRead;
          row.tokens.cacheCreate += parsed.cacheCreate;
          row.tokens.output += parsed.output;
          lastMsgId = parsed.id;
          lastOut = parsed.output;
          if (parsed.context > 0) {
            if (isCompaction(lastContext, parsed.context)) compactions += 1;
            lastContext = parsed.context;
          }
        }
      }
    }
    start = stop + 1;
  }
  return { consumed: end + 1, deltas: [...rows.values()], lastMsgId, lastOut, skipped, lastContext, compactions, lastModel };
}

type LineUsage = {
  id: string;
  model: string;
  timestamp: number | null;
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  context: number;
};

// The line Claude Code writes when it compacts a conversation: {type: 'system', subtype: 'compact_boundary',
// compactMetadata: {preTokens, postTokens}}.
function compactBoundary(line: string): { postTokens: number | null } | null {
  if (!line.includes('"compact_boundary"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = asRecord(raw);
  if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') return null;
  const post = count(asRecord(entry.compactMetadata).postTokens);
  return { postTokens: post > 0 ? post : null };
}

function lineUsage(line: string): LineUsage | null {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = asRecord(raw);
  const message = asRecord(entry.message);
  const usage = asRecord(message.usage);
  const id = message.id;
  const model = message.model;
  if (typeof id !== 'string' || id === '' || model === '<synthetic>') return null;
  const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  const input = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheCreate = count(usage.cache_creation_input_tokens);
  return {
    id,
    model: typeof model === 'string' ? model : '',
    timestamp: Number.isFinite(stamp) ? stamp : null,
    input,
    cacheRead,
    cacheCreate,
    output: count(usage.output_tokens),
    context: contextOf({ input, cacheRead, cacheCreate }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readRange(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = readSync(fd, buf, 0, length, offset);
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function toTotals(row: TotalsRow | null | undefined): TokenTotals {
  return row
    ? { turns: row.turns ?? 0, input: row.input ?? 0, cacheRead: row.cache_read ?? 0, cacheCreate: row.cache_create ?? 0, output: row.output ?? 0 }
    : zeroTotals();
}

const SUMS = `SUM(turns) AS turns, SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_create) AS cache_create, SUM(output) AS output`;

export type MeterOptions = {
  db: Database;
  claudeHome: string;
  now: () => number;
  onRead: (event: TokensEvent) => void;
  // Window of the model an agent runs on, given the biggest context it has held. Default: the table.
  windowFor?: (agent: MeterAgent, model: string | null, observed: number) => number;
};

export class TokenMeter {
  private readonly totalsByAgent = new Map<string, TokenTotals>();
  private readonly cursors = new Map<string, TokenCursor | null>();
  private readonly seenAgent = new Map<string, string>();
  private readonly seenSession = new Map<string, string>();
  private readonly found = new Map<string, string>();
  private readonly missed = new Map<string, number>();
  private readonly readAt = new Map<string, number>();
  private readonly more = new Set<string>();
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly oversized = new Set<string>();
  private readonly modelOf = new Map<string, string>();
  private readonly sentContext = new Map<string, string>();

  constructor(private readonly opts: MeterOptions) {
    const rows = opts.db
      .query<TotalsRow & { agent_key: string }, []>(`SELECT agent_key, ${SUMS} FROM token_usage GROUP BY agent_key`)
      .all();
    for (const row of rows) this.totalsByAgent.set(row.agent_key, toTotals(row));
  }

  noteSession(sessionId: string, path: unknown): void {
    if (typeof path === 'string' && path.endsWith('.jsonl')) this.seenSession.set(sessionId, path);
  }

  noteAgent(agentKey: string, path: unknown): void {
    if (typeof path === 'string' && path.endsWith('.jsonl')) this.seenAgent.set(agentKey, path);
  }

  // The transcript of a main session, if it exists: what `claude --resume` needs to find.
  transcriptOf(sessionId: string, cwd: string | null): string | null {
    return this.mainTranscript({ sessionId, cwd });
  }

  totals(agentKey: string): TokenTotals | null {
    const totals = this.totalsByAgent.get(agentKey);
    return totals ? { ...totals } : null;
  }

  planTotals(): Map<string, TokenTotals> {
    const rows = this.opts.db
      .query<TotalsRow & { plan_slug: string }, []>(`SELECT plan_slug, ${SUMS} FROM token_usage WHERE plan_slug != '' GROUP BY plan_slug`)
      .all();
    return new Map(rows.map((row) => [row.plan_slug, toTotals(row)]));
  }

  // Compactions the transcript of an agent has shown so far, as persisted.
  compactions(agentKey: string): number {
    return this.cursorOf(agentKey)?.compactions ?? 0;
  }

  lastRead(agentKey: string): number {
    return this.readAt.get(agentKey) ?? 0;
  }

  behind(agentKey: string): boolean {
    return this.more.has(agentKey);
  }

  forget(agentKeys: ReadonlySet<string>): void {
    for (const key of agentKeys) {
      this.totalsByAgent.delete(key);
      this.cursors.delete(key);
      this.modelOf.delete(key);
      this.sentContext.delete(key);
      this.seenAgent.delete(key);
      this.readAt.delete(key);
      this.more.delete(key);
    }
  }

  schedule(agent: MeterAgent): Promise<void> {
    const pending = this.scheduled.get(agent.key);
    if (pending) return pending;
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.scheduled.delete(agent.key);
        try {
          this.readNow(agent);
          // A long transcript is read in slices: the next one goes behind whatever else is waiting in the loop.
          if (this.behind(agent.key)) void this.schedule(agent);
        } finally {
          resolve();
        }
      }, 0);
    });
    this.scheduled.set(agent.key, task);
    return task;
  }

  readNow(agent: MeterAgent, plan: string | null = agent.plan, budget: number = READ_BUDGET): number {
    const subject: Subject = { agent, plan };
    this.readAt.set(agent.key, this.opts.now());
    const file = this.transcriptFor(agent);
    if (!file) return 0;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return 0;
    }
    if (size > MAX_FILE) {
      if (!this.oversized.has(file)) {
        this.oversized.add(file);
        console.error(`Agent Office: transcripción de más de ${MAX_FILE / 1024 / 1024} MB sin medir: ${basename(file)}`);
      }
      return 0;
    }
    let cursor = this.cursorOf(agent.key);
    if (!cursor || cursor.transcript !== file || size < cursor.offset) {
      cursor = {
        transcript: file,
        offset: 0,
        lastMsgId: null,
        lastOut: 0,
        skipped: cursor && cursor.transcript === file ? cursor.skipped : 0,
        lastContext: null,
        compactions: 0,
      };
    }

    let spent = 0;
    const added = zeroTotals();
    let changed = cursor !== this.cursors.get(agent.key);
    this.more.delete(agent.key);
    while (cursor.offset < size) {
      if (spent >= budget) {
        this.more.add(agent.key);
        break;
      }
      const result = this.readChunk(file, cursor, size, budget - spent);
      if (result.consumed === 0) break;
      spent += result.consumed;
      cursor = {
        ...cursor,
        offset: cursor.offset + result.consumed,
        lastMsgId: result.lastMsgId,
        lastOut: result.lastOut,
        skipped: cursor.skipped + result.skipped,
        lastContext: result.lastContext,
        compactions: cursor.compactions + result.compactions,
      };
      if (result.lastModel) this.modelOf.set(agent.key, result.lastModel);
      changed = true;
      for (const delta of result.deltas) {
        this.addRow(subject, delta);
        addTotals(added, delta.tokens);
      }
    }
    if (changed) this.saveCursor(agent, cursor);
    this.cursors.set(agent.key, cursor);

    const context = this.contextOf(agent, cursor);
    const signature = context ? `${context.tokens}:${context.compactions}` : '';
    const contextChanged = context !== null && this.sentContext.get(agent.key) !== signature;
    if (added.turns > 0 || added.output > 0 || contextChanged) {
      const total = this.totalsByAgent.get(agent.key) ?? zeroTotals();
      if (added.turns > 0 || added.output > 0) {
        addTotals(total, added);
        this.totalsByAgent.set(agent.key, total);
      }
      if (context) this.sentContext.set(agent.key, signature);
      const slug = plan ?? '';
      this.opts.onRead({
        agentKey: agent.key,
        tokens: { ...total },
        plan: slug === '' ? null : { slug, tokens: this.planTotals().get(slug) ?? zeroTotals() },
        context,
      });
    }
    return spent;
  }

  summary(range: UsageRange): UsageSummary {
    const now = this.opts.now();
    const to = localDay(now);
    const back = new Date(now);
    back.setDate(back.getDate() - (range === 'week' ? 6 : 0));
    const from = localDay(back.getTime());
    const group = (column: string, where = ''): TokenRow[] =>
      this.opts.db
        .query<TotalsRow & { key: string; agents: number }, [string, string]>(
          `SELECT ${column} AS key, ${SUMS}, COUNT(DISTINCT agent_key) AS agents FROM token_usage WHERE day >= ? AND day <= ? ${where} GROUP BY ${column}`,
        )
        .all(from, to)
        .map((row) => ({ key: row.key, tokens: toTotals(row), agents: row.agents }))
        .sort((a, b) => grandTotal(b.tokens) - grandTotal(a.tokens) || a.key.localeCompare(b.key));
    const total = this.opts.db
      .query<TotalsRow & { agents: number }, [string, string]>(
        `SELECT ${SUMS}, COUNT(DISTINCT agent_key) AS agents FROM token_usage WHERE day >= ? AND day <= ?`,
      )
      .get(from, to);
    const perDay = new Map(group('day').map((row) => [row.key, grandTotal(row.tokens)]));
    const byDay: UsageDay[] = [];
    for (let back = range === 'week' ? 6 : 0; back >= 0; back--) {
      const at = new Date(now);
      at.setDate(at.getDate() - back);
      const day = localDay(at.getTime());
      byDay.push({ day, tokens: perDay.get(day) ?? 0 });
    }
    return {
      range,
      from,
      to,
      total: { tokens: toTotals(total), agents: total?.agents ?? 0 },
      byDay,
      byRole: group("COALESCE(role_id, '')"),
      byModel: group('model'),
      byFloor: group('floor'),
      byPlan: group('plan_slug', "AND plan_slug != ''"),
    };
  }

  private contextOf(agent: MeterAgent, cursor: TokenCursor): AgentContext | null {
    if (cursor.lastContext === null) return null;
    const model = this.modelOf.get(agent.key) ?? null;
    const window = this.opts.windowFor?.(agent, model, cursor.lastContext) ?? defaultWindow(model, { observed: cursor.lastContext });
    return agentContext(cursor.lastContext, window, cursor.compactions, 'transcript', this.opts.now());
  }

  private readChunk(file: string, cursor: TokenCursor, size: number, room: number): ChunkResult {
    const left = size - cursor.offset;
    let result: ChunkResult | null = null;
    let length = 0;
    for (const limit of [Math.max(1, Math.min(READ_CHUNK, room)), MIN_CHUNK, MAX_LINE, MAX_LINE_READ]) {
      length = Math.min(left, limit);
      result = parseChunk(readRange(file, cursor.offset, length), cursor, this.opts.now());
      if (result.consumed > 0 || left <= length) break;
    }
    if (result && result.consumed === 0 && length >= MAX_LINE_READ) {
      return {
        consumed: length,
        deltas: [],
        lastMsgId: cursor.lastMsgId,
        lastOut: cursor.lastOut,
        skipped: 1,
        lastContext: cursor.lastContext,
        compactions: 0,
        lastModel: null,
      };
    }
    return result as ChunkResult;
  }

  private addRow(subject: Subject, delta: TokenDelta): void {
    const { agent, plan } = subject;
    this.opts.db
      .query(
        `INSERT INTO token_usage (day, agent_key, session_id, floor, role_id, name, model, plan_slug, turns, input, cache_read, cache_create, output, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, agent_key, model, plan_slug) DO UPDATE SET
           session_id = excluded.session_id, floor = excluded.floor, role_id = excluded.role_id, name = excluded.name,
           turns = turns + excluded.turns, input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
           cache_create = cache_create + excluded.cache_create, output = output + excluded.output, updated_at = excluded.updated_at`,
      )
      .run(
        delta.day,
        agent.key,
        agent.sessionId,
        agent.floor,
        agent.roleId,
        agent.name,
        delta.model,
        plan ?? '',
        delta.tokens.turns,
        delta.tokens.input,
        delta.tokens.cacheRead,
        delta.tokens.cacheCreate,
        delta.tokens.output,
        this.opts.now(),
      );
  }

  private saveCursor(agent: MeterAgent, cursor: TokenCursor): void {
    this.opts.db
      .query(
        `INSERT INTO token_cursor (agent_key, session_id, floor, transcript, byte_offset, last_msg_id, last_out, skipped_lines, last_context, compactions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_key) DO UPDATE SET session_id = excluded.session_id, floor = excluded.floor, transcript = excluded.transcript,
           byte_offset = excluded.byte_offset, last_msg_id = excluded.last_msg_id, last_out = excluded.last_out,
           skipped_lines = excluded.skipped_lines, last_context = excluded.last_context, compactions = excluded.compactions,
           updated_at = excluded.updated_at`,
      )
      .run(
        agent.key,
        agent.sessionId,
        agent.floor,
        cursor.transcript,
        cursor.offset,
        cursor.lastMsgId,
        cursor.lastOut,
        cursor.skipped,
        cursor.lastContext,
        cursor.compactions,
        this.opts.now(),
      );
  }

  private cursorOf(agentKey: string): TokenCursor | null {
    if (this.cursors.has(agentKey)) return this.cursors.get(agentKey) ?? null;
    const row = this.opts.db
      .query<CursorRow, [string]>(
        'SELECT transcript, byte_offset, last_msg_id, last_out, skipped_lines, last_context, compactions FROM token_cursor WHERE agent_key = ?',
      )
      .get(agentKey);
    const cursor: TokenCursor | null = row
      ? {
          transcript: row.transcript,
          offset: row.byte_offset,
          lastMsgId: row.last_msg_id,
          lastOut: row.last_out,
          skipped: row.skipped_lines,
          lastContext: row.last_context,
          compactions: row.compactions ?? 0,
        }
      : null;
    this.cursors.set(agentKey, cursor);
    return cursor;
  }

  private projectsDir(): string {
    return join(realPath(this.opts.claudeHome), 'projects');
  }

  private accept(candidate: string | null | undefined): string | null {
    if (!candidate || !candidate.endsWith('.jsonl')) return null;
    let resolved: string;
    try {
      resolved = realPath(candidate);
      if (!statSync(resolved).isFile()) return null;
    } catch {
      return null;
    }
    return resolved.startsWith(this.projectsDir() + sep) && resolved.endsWith('.jsonl') ? resolved : null;
  }

  private transcriptFor(agent: MeterAgent): string | null {
    const isMain = agent.key === agent.sessionId;
    return (
      this.accept(this.seenAgent.get(agent.key)) ??
      this.accept(this.cursorOf(agent.key)?.transcript) ??
      (isMain ? this.mainTranscript(agent) : this.subagentTranscript(agent))
    );
  }

  private mainTranscript(agent: Pick<MeterAgent, 'sessionId' | 'cwd'>): string | null {
    const seen = this.accept(this.seenSession.get(agent.sessionId));
    if (seen) return seen;
    if (agent.cwd) {
      const built = this.accept(join(this.projectsDir(), projectSlug(agent.cwd), `${agent.sessionId}.jsonl`));
      if (built) return built;
    }
    return this.sweepFor(agent.sessionId);
  }

  private subagentTranscript(agent: MeterAgent): string | null {
    for (const folder of this.sessionFolders(agent)) {
      const dir = join(folder, agent.sessionId, 'subagents');
      if (AGENT_ID.test(agent.key)) {
        const byId = this.accept(join(dir, `agent-${agent.key}.jsonl`));
        if (byId) return byId;
      }
      const byName = agent.name ? this.byMetaName(dir, agent.name) : null;
      if (byName) return byName;
    }
    return null;
  }

  private sessionFolders(agent: Pick<MeterAgent, 'sessionId' | 'cwd'>): string[] {
    const folders: string[] = [];
    const seen = this.seenSession.get(agent.sessionId);
    if (seen) folders.push(dirname(seen));
    if (agent.cwd) folders.push(join(this.projectsDir(), projectSlug(agent.cwd)));
    const swept = this.sweepFor(agent.sessionId);
    if (swept) folders.push(dirname(swept));
    return folders;
  }

  private byMetaName(dir: string, name: string): string | null {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    let best: { path: string; mtime: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      const transcript = join(dir, `${entry.slice(0, -'.meta.json'.length)}.jsonl`);
      try {
        const meta = asRecord(JSON.parse(readFileSync(join(dir, entry), 'utf8')));
        if (meta.name !== name) continue;
        const mtime = statSync(transcript).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: transcript, mtime };
      } catch {
        continue;
      }
    }
    return best ? this.accept(best.path) : null;
  }

  private sweepFor(sessionId: string): string | null {
    const known = this.found.get(sessionId);
    if (known && existsSync(known)) return known;
    const missed = this.missed.get(sessionId);
    if (missed !== undefined && this.opts.now() - missed < SWEEP_MISS_MS) return null;
    const root = this.projectsDir();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      const hit = this.accept(join(root, dir, `${sessionId}.jsonl`));
      if (hit) {
        this.found.set(sessionId, hit);
        return hit;
      }
    }
    this.missed.set(sessionId, this.opts.now());
    return null;
  }
}
