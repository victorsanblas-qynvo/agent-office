export type DiffLineKind = 'context' | 'add' | 'del' | 'note';
export type DiffLine = { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] };
export type FileDiff = {
  oldPath: string | null;
  newPath: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: DiffHunk[];
  adds: number;
  dels: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };

// Reads a C-style quoted token at the start of `s`; returns the value and what follows it.
function readQuoted(s: string): { value: string; rest: string } | null {
  if (!s.startsWith('"')) return null;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  let i = 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      const octal = /^[0-7]{3}/.exec(s.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 4;
        continue;
      }
      bytes.push(...enc.encode(ESCAPES[s[i + 1]!] ?? s[i + 1]!));
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    bytes.push(...enc.encode(ch));
    i += ch.length;
  }
  if (s[i] !== '"') return null;
  return { value: new TextDecoder().decode(new Uint8Array(bytes)), rest: s.slice(i + 1) };
}

function unquote(s: string): string {
  return readQuoted(s)?.value ?? s;
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

// `a/X b/Y` after `diff --git `, quoted or not; unquoted paths with spaces are split where both halves agree.
function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } | null {
  let left: string;
  let right: string;
  const first = readQuoted(rest);
  if (first) {
    left = first.value;
    const tail = first.rest.replace(/^ /, '');
    right = unquote(tail);
  } else {
    const cuts: number[] = [];
    for (let i = rest.indexOf(' b/'); i >= 0; i = rest.indexOf(' b/', i + 1)) cuts.push(i);
    if (cuts.length === 0) {
      const q = rest.indexOf(' "');
      if (q < 0) return null;
      left = rest.slice(0, q);
      right = unquote(rest.slice(q + 1));
    } else {
      const agree = cuts.find((c) => stripPrefix(rest.slice(0, c), 'a/') === stripPrefix(rest.slice(c + 1), 'b/'));
      const cut = agree ?? cuts[0]!;
      left = rest.slice(0, cut);
      right = rest.slice(cut + 1);
    }
  }
  return { oldPath: stripPrefix(left, 'a/'), newPath: stripPrefix(right, 'b/') };
}

// The path of a `---` / `+++` line: no trailing tab/timestamp, /dev/null is null.
function markerPath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const quoted = readQuoted(raw);
  const value = quoted ? quoted.value : raw.replace(/\t.*$/, '');
  if (value === '/dev/null') return null;
  return stripPrefix(value, prefix);
}

type Builder = { file: FileDiff; git: boolean };

function blank(): FileDiff {
  return { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [], adds: 0, dels: 0 };
}

export function parseDiff(patch: string): FileDiff[] {
  if (!patch) return [];
  const rows = patch.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (rows[rows.length - 1] === '') rows.pop();

  const files: FileDiff[] = [];
  let cur: Builder | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const start = (git: boolean): Builder => {
    const file = blank();
    files.push(file);
    cur = { file, git };
    hunk = null;
    return cur;
  };

  for (const line of rows) {
    if (line.startsWith('diff --git ')) {
      const b = start(true);
      const paths = gitHeaderPaths(line.slice('diff --git '.length));
      if (paths) {
        b.file.oldPath = paths.oldPath;
        b.file.newPath = paths.newPath;
      }
      continue;
    }

    const inBody: boolean = hunk !== null && (oldLeft > 0 || newLeft > 0);
    if (hunk && inBody) {
      const marker = line[0];
      if (marker === ' ' || marker === '+' || marker === '-' || line === '') {
        const text = line.slice(1);
        if (marker === '+') {
          hunk.lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
          newLeft--;
          cur!.file.adds++;
        } else if (marker === '-') {
          hunk.lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
          oldLeft--;
          cur!.file.dels++;
        } else {
          hunk.lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
          oldLeft--;
          newLeft--;
        }
        continue;
      }
    }

    if (hunk && line.startsWith('\\')) {
      hunk.lines.push({ kind: 'note', text: line.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }

    const m = HUNK.exec(line);
    if (m) {
      const b: Builder = cur ?? start(false);
      const oldStart = Number(m[1]);
      const newStart = Number(m[3]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: line, oldStart, oldLines, newStart, newLines, section: m[5] ?? '', lines: [] };
      b.file.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }

    if (line.startsWith('--- ')) {
      let b = cur as Builder | null;
      if (!b || (!b.git && b.file.hunks.length > 0)) b = start(false);
      b.file.oldPath = markerPath(line.slice(4), 'a/');
      if (b.file.oldPath === null && b.file.status === 'modified') b.file.status = 'added';
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ') && cur) {
      const b: Builder = cur;
      b.file.newPath = markerPath(line.slice(4), 'b/');
      if (b.file.newPath === null && b.file.status === 'modified') b.file.status = 'deleted';
      continue;
    }

    if (!cur) continue;
    const f: FileDiff = (cur as Builder).file;
    if (line.startsWith('new file mode')) {
      f.status = 'added';
      f.oldPath = null;
    } else if (line.startsWith('deleted file mode')) {
      f.status = 'deleted';
      f.newPath = null;
    } else if (line.startsWith('rename from ')) {
      f.status = 'renamed';
      f.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      f.status = 'renamed';
      f.newPath = unquote(line.slice('rename to '.length));
    } else if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
      f.binary = true;
    }
  }
  return files;
}

export function splitRows(hunk: DiffHunk): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const out: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let delNotes: DiffLine[] = [];
  let addNotes: DiffLine[] = [];
  let prev: DiffLineKind = 'context';
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    const notes = Math.max(delNotes.length, addNotes.length);
    for (let i = 0; i < notes; i++) out.push({ left: delNotes[i] ?? null, right: addNotes[i] ?? null });
    dels = [];
    adds = [];
    delNotes = [];
    addNotes = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') {
      if (adds.length > 0) flush();
      dels.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else if (line.kind === 'note' && (dels.length > 0 || adds.length > 0)) {
      if (prev === 'add') addNotes.push(line);
      else delNotes.push(line);
    } else {
      flush();
      if (line.kind === 'context') out.push({ left: line, right: line });
      else out.push({ left: prev === 'add' ? null : line, right: prev === 'del' ? null : line });
    }
    prev = line.kind === 'note' ? prev : line.kind;
  }
  flush();
  return out;
}
