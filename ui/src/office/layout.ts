import type { LiftFace } from '../lift';
import type { AgentView, FloorLayoutOverride, FloorView, RoleKind, Spot } from '../types';
import {
  CHILD_SCALE,
  CHILD_SLOT_W,
  FLOOR_GAP,
  LEAD_SLOT_W,
  LIFT_W,
  MARGIN,
  MIN_FLOOR_H,
  ROW_H,
  SLOT_H,
  SLOT_W,
  UTIL_W,
  WALL_H,
} from './constants';

export type Point = { x: number; y: number; floor?: string };
export type Rect = { x: number; y: number; w: number; h: number };
export type DeskSlot = { x: number; y: number; scale: number; width: number; lead: boolean };
export type Seat = Point & { behind: boolean };

export type FloorLayout = {
  width: number;
  // How far the whiteboard is from its place on the wall, in pixels.
  boardShift: number;
  height: number;
  leadDesk: DeskSlot | null;
  desks: Map<string, DeskSlot>;
  labBench: Point;
  labStands: Point[];
  coffee: Point;
  coffeeStands: Point[];
  rug: Rect;
  table: Point;
  seats: Seat[];
  lift: Rect;
  walkY: number;
  windows: Point[];
};

function leadKindFor(floor: FloorView): RoleKind | null {
  if (floor.kind === 'direccion') return 'director';
  if (floor.kind === 'observed') return null;
  return 'lead';
}

// Rows of desks as the 3D plan has them: the user's v picks the nearer one.
const ROW_V = [0.219, 0.544] as const;

export function rowOf(v: number): number {
  return Math.abs(v - ROW_V[0]) <= Math.abs(v - ROW_V[1]) ? 0 : 1;
}

export function computeFloorLayout(
  floor: FloorView,
  agents: readonly AgentView[],
  width: number,
  order: (key: string) => number,
  override?: FloorLayoutOverride,
): FloorLayout {
  const leadKind = leadKindFor(floor);
  const ordered = [...agents].sort((a, b) => order(a.key) - order(b.key));
  const keys = new Set(ordered.map((agent) => agent.key));
  const children = new Map<string, AgentView[]>();
  const roots: AgentView[] = [];
  for (const agent of ordered) {
    if (agent.parentKey !== null && agent.parentKey !== agent.key && keys.has(agent.parentKey)) {
      const siblings = children.get(agent.parentKey) ?? [];
      siblings.push(agent);
      children.set(agent.parentKey, siblings);
    } else {
      roots.push(agent);
    }
  }

  const areaTop = WALL_H + 8;
  const xMax = Math.max(width - UTIL_W - MARGIN, MARGIN + SLOT_W);
  const desks = new Map<string, DeskSlot>();
  let cursorX = MARGIN;
  let cursorY = areaTop;
  let leadDesk: DeskSlot | null = null;

  if (leadKind !== null) {
    leadDesk = { x: MARGIN, y: areaTop, scale: 1, width: LEAD_SLOT_W, lead: true };
    cursorX = MARGIN + LEAD_SLOT_W + 2;
  }

  const place = (key: string, slotWidth: number, scale: number): void => {
    if (cursorX + slotWidth > xMax && cursorX > MARGIN) {
      cursorX = MARGIN;
      cursorY += ROW_H;
    }
    desks.set(key, { x: cursorX, y: cursorY + (1 - scale) * SLOT_H, scale, width: slotWidth, lead: false });
    cursorX += slotWidth + 2;
  };

  const visited = new Set<string>();
  const placeChildren = (parentKey: string): void => {
    for (const child of children.get(parentKey) ?? []) {
      if (visited.has(child.key)) continue;
      visited.add(child.key);
      place(child.key, CHILD_SLOT_W, CHILD_SCALE);
      placeChildren(child.key);
    }
  };

  const leadAgent = leadKind === null ? undefined : roots.find((agent) => agent.roleKind === leadKind);
  if (leadAgent && leadDesk) {
    visited.add(leadAgent.key);
    desks.set(leadAgent.key, leadDesk);
    placeChildren(leadAgent.key);
  }
  for (const root of roots) {
    if (visited.has(root.key)) continue;
    visited.add(root.key);
    place(root.key, SLOT_W, 1);
    placeChildren(root.key);
  }
  for (const agent of ordered) {
    if (visited.has(agent.key)) continue;
    visited.add(agent.key);
    place(agent.key, SLOT_W, 1);
  }

  let lastRow = Math.max(0, Math.round((cursorY - areaTop) / ROW_H));
  if (override) lastRow = Math.max(lastRow, applyDeskOverrides(width, areaTop, leadDesk, [...desks.values()].filter((slot) => !slot.lead), override));
  const height = Math.max(MIN_FLOOR_H, areaTop + lastRow * ROW_H + ROW_H + 10);
  const unitX = width - UTIL_W;
  const shifts = furnitureShifts(width, height, unitX, override);
  const labBench = { x: unitX + 4 + shifts.lab.dx, y: WALL_H - 18 };
  const rug = { x: unitX + 4 + shifts.meeting.dx, y: 66 + shifts.meeting.dy, w: 92, h: 52 };
  const table = { x: rug.x + 24, y: rug.y + 14 };
  const windows: Point[] = [];
  for (let x = 100; x + 26 < unitX - 4; x += 48) windows.push({ x, y: 6 });

  const coffee = { x: unitX + 70 + shifts.coffee.dx, y: WALL_H - 22 };
  return {
    width,
    boardShift: shifts.board.dx,
    height,
    leadDesk,
    desks,
    labBench,
    labStands: [12, 29, 46].map((dx) => ({ x: labBench.x + dx, y: WALL_H + 16 })),
    coffee,
    coffeeStands: [-2, 18].map((dx) => ({ x: coffee.x + dx, y: WALL_H + 16 })),
    rug,
    table,
    seats: [
      { x: table.x + 11, y: table.y + 6, behind: true },
      { x: table.x + 33, y: table.y + 6, behind: true },
      { x: table.x - 8, y: table.y + 18, behind: false },
      { x: table.x + 52, y: table.y + 18, behind: false },
    ],
    lift: { x: width - LIFT_W - 2, y: WALL_H - 4, w: LIFT_W, h: height - WALL_H + 4 },
    walkY: height - 8,
    windows,
  };
}

type Shift2D = { dx: number; dy: number };

const NO_SHIFT: Shift2D = { dx: 0, dy: 0 };

// The 2D floor is as deep as its rows of desks, so the user's v is read over the floor once it is known. The
// coffee machine, the lab bench and the whiteboard hang on the wall and only slide along it; the table and its
// rug move on the floor. Unmoved pieces come out exactly where they always were.
function furnitureShifts(width: number, height: number, unitX: number, override?: FloorLayoutOverride): Record<'coffee' | 'lab' | 'board' | 'meeting', Shift2D> {
  const none = { coffee: NO_SHIFT, lab: NO_SHIFT, board: NO_SHIFT, meeting: NO_SHIFT };
  const moved = override?.furniture;
  if (!moved) return none;
  const along = (spot: Spot | undefined, centre: number): Shift2D => (spot ? { dx: Math.round(spot.u * width - centre), dy: 0 } : NO_SHIFT);
  const meeting = moved.meeting;
  const floorTop = WALL_H;
  const floorBottom = height - 8;
  return {
    coffee: along(moved.coffee, unitX + 70 + 8),
    lab: along(moved.lab, unitX + 4 + 29),
    board: along(moved.board, width - UTIL_W - 4 - 30.5),
    meeting: meeting
      ? { dx: Math.round(meeting.u * width - (unitX + 4 + 46)), dy: Math.round(floorTop + meeting.v * (floorBottom - floorTop) - (66 + 26)) }
      : NO_SHIFT,
  };
}

// Moves the desks the user placed: the nearest of the two rows, inside the floor, and only where there is room
// for the others; otherwise the desk stays where the grid put it. Returns the lowest row in use.
function applyDeskOverrides(width: number, areaTop: number, lead: DeskSlot | null, slots: DeskSlot[], override: FloorLayoutOverride): number {
  const xMax = Math.max(width - UTIL_W - MARGIN, MARGIN + SLOT_W);
  const all = lead ? [lead, ...slots] : slots;
  let lowest = 0;
  const attempt = (slot: DeskSlot, spot: Spot | null | undefined): void => {
    if (!spot) return;
    const x = Math.round(Math.min(Math.max(spot.u * width - slot.width / 2, MARGIN), xMax - slot.width));
    const row = slot.lead ? 0 : rowOf(spot.v);
    const y = areaTop + row * ROW_H + (1 - slot.scale) * SLOT_H;
    const clash = all.some((other) => other !== slot && Math.abs(other.y - y) < ROW_H / 2 && Math.abs(other.x - x) < Math.min(other.width, slot.width) * 0.8);
    if (clash) return;
    slot.x = x;
    slot.y = y;
  };
  if (lead) attempt(lead, override.lead);
  slots.forEach((slot, index) => attempt(slot, override.desks?.[index]));
  for (const slot of all) lowest = Math.max(lowest, Math.round((slot.y - areaTop - (1 - slot.scale) * SLOT_H) / ROW_H));
  return lowest;
}

export type LiftLeg = { from: string; to: string; fromFace: LiftFace; toFace: LiftFace; approach: boolean };

export function liftCenter(layout: FloorLayout): number {
  return layout.lift.x + layout.lift.w / 2;
}

export function liftGate(layout: FloorLayout, top: number, slug?: string): Point {
  const gate: Point = { x: liftCenter(layout), y: top + layout.walkY };
  if (slug !== undefined) gate.floor = slug;
  return gate;
}

export function gardenDoor(layout: FloorLayout, top: number): Point {
  return { x: liftCenter(layout), y: top + layout.height + FLOOR_GAP + 8 };
}

export function gardenRoute(gate: Point, door: Point, pathY: number, spot: Point): Point[] {
  return [gate, door, { x: door.x, y: pathY }, { x: spot.x, y: pathY }, spot];
}

export function gardenArrival(from: Point, door: Point, pathY: number, gate: Point): Point[] {
  const points: Point[] = from.y > pathY ? [{ x: from.x, y: pathY }] : [];
  points.push({ x: door.x, y: pathY }, door, gate);
  return points;
}

export function liftRoute(from: Point | null, to: Point | null, ...rest: Point[]): Point[] {
  const points: Point[] = [];
  for (const point of [from, to]) {
    if (point && !points.some((p) => p.x === point.x && p.y === point.y)) points.push(point);
  }
  points.push(...rest);
  return points;
}

export function liftLeg(path: readonly Point[], serves: (from: string, to: string) => boolean): LiftLeg | null {
  const [gate, next] = path;
  if (gate?.floor === undefined || next?.floor === undefined || gate.floor === next.floor) return null;
  if (!serves(gate.floor, next.floor)) return null;
  return { from: gate.floor, to: next.floor, fromFace: 'room', toFace: 'room', approach: true };
}
