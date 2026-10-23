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

// Only the pins that still point at a live agent use up the cap; with no snapshot yet every pin counts.
export function canPin(pins: readonly string[], key: string, agents?: ReadonlyMap<string, AgentView>): boolean {
  if (pins.includes(key)) return true;
  const used = agents && agents.size > 0 ? pinnedRows(agents, pins).length : pins.length;
  return used < MAX_PINS;
}

// Pins the agent at the end, or unpins it; pins of agents that are gone or ended are dropped once the agents are known, and a full strip leaves the list as it was.
export function togglePin(pins: readonly string[], key: string, agents?: ReadonlyMap<string, AgentView>): string[] {
  if (pins.includes(key)) return pins.filter((pin) => pin !== key);
  const kept = agents && agents.size > 0 ? pins.filter((pin) => agents.get(pin)?.endedAt === null) : [...pins];
  return kept.length < MAX_PINS ? [...kept, key] : [...pins];
}
