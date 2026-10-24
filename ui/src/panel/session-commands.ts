import type { AgentView, SessionView } from '../types';

export type SessionCommands = { tmux?: string; resume?: string };

const TMUX_SESSION = 'agent-office';
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sessionCommands(session: SessionView | undefined, agent: AgentView): SessionCommands {
  if (session === undefined || !session.office || agent.key !== agent.sessionId || session.sessionId !== agent.sessionId) return {};
  const commands: SessionCommands = {};
  if (session.endedAt === null && session.name !== null && SAFE_NAME.test(session.name)) {
    commands.tmux = `tmux select-window -t ${quoted(`${TMUX_SESSION}:=${session.name}`)} && tmux attach -t ${TMUX_SESSION}`;
  }
  if (SAFE_ID.test(session.sessionId) && session.cwd !== null && session.cwd !== '' && !CONTROL.test(session.cwd)) {
    commands.resume = `cd ${quoted(session.cwd)} && claude --resume ${session.sessionId}`;
  }
  return commands;
}
