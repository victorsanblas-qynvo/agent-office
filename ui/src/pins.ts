import type { AgentView } from './types';

export const MAX_PINS = 4;

// The pinned agents that are still around and not finished, in the order they were pinned.
export function pinnedRows(agents: ReadonlyMap<string, AgentView>, pins: readonly string[]): AgentView[] {
  const rows: AgentView[] = [];
  for (const key of pins) {
    const agent = agents.get(key);
    if (agent && agent.endedAt === null && rows.length < MAX_PINS) rows.push(agent);
  }
  return rows;
}

export function canPin(pins: readonly string[], key: string): boolean {
  return pins.includes(key) || pins.length < MAX_PINS;
}

// Pins the agent at the end, or unpins it; a full strip leaves the list as it was.
export function togglePin(pins: readonly string[], key: string): string[] {
  if (pins.includes(key)) return pins.filter((pin) => pin !== key);
  return pins.length < MAX_PINS ? [...pins, key] : [...pins];
}
