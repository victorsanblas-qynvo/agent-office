const SAFE = /^[A-Za-z0-9._\/-]+$/;
const BODY_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const UNSAFE_REF = /^-|[\s\x00-\x1f\x7f-\x9f]/;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function arg(value: string): string {
  return SAFE.test(value) ? value : quote(value);
}

function ref(flag: string, value: string | null): string | null {
  return value && !UNSAFE_REF.test(value) ? `${flag} ${arg(value)}` : null;
}

// A lone carriage return turns into a line end in a textarea and in a terminal paste, so it is one here too.
function cleanBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(BODY_CONTROLS, '');
}

function cleanTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pure: the `gh pr create` that opens the draft, with the body read from a heredoc whose delimiter is not a line of the
// cleaned body. A ref that could pass for an option or split into words is left out.
export function ghCommand(draft: { title: string; body: string }, base: string | null, branch: string | null): string {
  const body = cleanBody(draft.body);
  const lines = new Set(body.split('\n'));
  let delimiter = 'AGENT_OFFICE_PR';
  for (let n = 2; lines.has(delimiter); n += 1) delimiter = `AGENT_OFFICE_PR_${n}`;
  const flags = [ref('--base', base), ref('--head', branch), `--title ${quote(cleanTitle(draft.title))}`, '--body-file -'];
  return `gh pr create ${flags.filter((flag) => flag !== null).join(' ')} <<'${delimiter}'\n${body}\n${delimiter}`;
}
