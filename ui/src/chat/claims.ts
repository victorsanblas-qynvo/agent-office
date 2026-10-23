import type { ChatClaimView, ChatMessageView } from '../types';

// The same rule as ChatDesk.openClaims in the hub, over the messages the panel holds.
export const CLAIM_TTL_MS = 4 * 3_600_000;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export const BADGE_REFRESH_MS = 60_000;

// Pure: whether the collision badge is due a recompute, once a minute so an expired claim drops out.
export function badgeDue(last: number, now: number): boolean {
  return now - last >= BADGE_REFRESH_MS || now < last;
}

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes('/') && b.includes('/')) return false;
  return baseName(a) === baseName(b);
}

// Files someone announced with toca and has not released with listo yet, from the last four hours.
export function openClaims(messages: readonly ChatMessageView[], now: number): ChatClaimView[] {
  const recent = messages
    .filter((message) => (message.kind === 'toca' || message.kind === 'listo') && message.ts >= now - CLAIM_TTL_MS)
    .sort((a, b) => a.id - b.id);
  let open: ChatClaimView[] = [];
  for (const message of recent) {
    open = open.filter((claim) => claim.authorKey !== message.authorKey || !message.files.some((file) => samePath(file, claim.file)));
    if (message.kind !== 'toca') continue;
    for (const file of message.files) open.push({ file, authorKey: message.authorKey, authorName: message.authorName, ts: message.ts, id: message.id });
  }
  return open;
}

export type HeldClaim = ChatClaimView & { channel: string; floor: string };

export type ClaimHolder = { key: string; name: string; floor: string; since: number };

export type Collision = { path: string; channel: string; holders: ClaimHolder[]; since: number };

// The open claims of every channel, each with the channel and the floor of the message that made it.
export function heldClaims(messages: readonly ChatMessageView[], now: number): HeldClaim[] {
  const byChannel = new Map<string, ChatMessageView[]>();
  for (const message of messages) {
    const list = byChannel.get(message.channel);
    if (list) list.push(message);
    else byChannel.set(message.channel, [message]);
  }
  const held: HeldClaim[] = [];
  for (const [channel, list] of byChannel) {
    const floors = new Map(list.map((message) => [message.id, message.floor]));
    for (const claim of openClaims(list, now)) held.push({ ...claim, channel, floor: floors.get(claim.id) ?? channel });
  }
  return held;
}

// Paths claimed by two or more sessions of one channel, the most recent claim first. A session that claims a
// path twice counts once; paths match as the hub does (samePath).
export function collisions(claims: readonly HeldClaim[]): Collision[] {
  const groups: { path: string; channel: string; claims: HeldClaim[] }[] = [];
  for (const claim of [...claims].sort((a, b) => b.id - a.id)) {
    const group = groups.find((item) => item.channel === claim.channel && samePath(item.path, claim.file));
    if (!group) groups.push({ path: claim.file, channel: claim.channel, claims: [claim] });
    else {
      group.claims.push(claim);
      if (!group.path.includes('/') && claim.file.includes('/')) group.path = claim.file;
    }
  }
  const found: Collision[] = [];
  for (const group of groups) {
    const holders: ClaimHolder[] = [];
    for (const claim of group.claims) {
      if (holders.some((holder) => holder.key === claim.authorKey)) continue;
      holders.push({ key: claim.authorKey, name: claim.authorName, floor: claim.floor, since: claim.ts });
    }
    if (holders.length >= 2) found.push({ path: group.path, channel: group.channel, holders, since: holders[0].since });
  }
  return found.sort((a, b) => b.since - a.since || a.path.localeCompare(b.path));
}
