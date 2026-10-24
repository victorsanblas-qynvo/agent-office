import type { AgentView, MessageView, OrderView, ServerMessage } from './types';

// Protocol prefixes, as in the hub state machine (which cannot load in the browser). Not translated.
const BLOCK_PREFIX = /^\s*BLOQUEADO\s*:/i;
const DONE_PREFIX = /^\s*HECHO\s*:/i;

export type DeliveryContext = { agents: ReadonlyMap<string, AgentView>; orders: readonly OrderView[] };

export function isBlockedText(text: string): boolean {
  return BLOCK_PREFIX.test(text);
}

export function isDoneText(text: string): boolean {
  return DONE_PREFIX.test(text);
}

export function isBlockedMessage(message: MessageView): boolean {
  return message.text !== null && isBlockedText(message.text);
}

// A floor that works with orders says its ends through the alert of the order, which only an accepted HECHO makes.
export function isTracked(store: DeliveryContext, agentKey: string): boolean {
  const floor = store.agents.get(agentKey)?.floor;
  return floor !== undefined && store.orders.some((order) => order.floor === floor && order.worktree !== null);
}

// The floor of a HECHO of a lead whose floor does not track orders, or null for any other message.
export function leadDeliveryFloor(store: DeliveryContext, message: MessageView): string | null {
  if (message.text === null || !isDoneText(message.text)) return null;
  const lead = store.agents.get(message.fromKey);
  if (lead === undefined || lead.roleKind !== 'lead' || isTracked(store, message.fromKey)) return null;
  return lead.floor;
}

// The floors a message delivers to: the end popup of an order or plan, or the HECHO of a lead without orders.
export function deliveryFloors(store: DeliveryContext, message: ServerMessage): string[] {
  if (message.type === 'finished') return message.data.floors;
  if (message.type === 'message') {
    const floor = leadDeliveryFloor(store, message.data);
    return floor === null ? [] : [floor];
  }
  return [];
}
