const SAFE = /^[A-Za-z0-9._\/-]+$/;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function arg(value: string): string {
  return SAFE.test(value) ? value : quote(value);
}

// Pure: the `gh pr create` that opens the draft, with the body read from a heredoc whose delimiter is not a line of the body.
export function ghCommand(draft: { title: string; body: string }, base: string | null, branch: string | null): string {
  const lines = new Set(draft.body.split('\n'));
  let delimiter = 'AGENT_OFFICE_PR';
  for (let n = 2; lines.has(delimiter); n += 1) delimiter = `AGENT_OFFICE_PR_${n}`;
  const flags = [base ? `--base ${arg(base)}` : null, branch ? `--head ${arg(branch)}` : null, `--title ${quote(draft.title)}`, '--body-file -'];
  return `gh pr create ${flags.filter((flag) => flag !== null).join(' ')} <<'${delimiter}'\n${draft.body}\n${delimiter}`;
}
