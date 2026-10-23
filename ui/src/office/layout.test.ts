import { describe, expect, test } from 'bun:test';
import type { AgentView, FloorView } from '../types';
import { FLOOR_GAP, MARGIN, MIN_FLOOR_H, ROW_H, SLOT_H, UTIL_W, WALL_H } from './constants';
import { computeFloorLayout, gardenArrival, gardenDoor, gardenRoute, liftGate, liftLeg, liftRoute, rowOf } from './layout';

const WIDTH = 400;

function agent(key: string, roleKind: AgentView['roleKind'], floor: string, parentKey: string | null = null): AgentView {
  return {
    key,
    sessionId: 's-1',
    parentKey,
    name: key,
    role: null,
    roleId: null,
    roleKind,
    floor,
    touchedFloor: null,
    state: 'idle',
    detail: '',
    tool: null,
    lastTest: null,
    stateSince: 0,
    updatedAt: 0,
    endedAt: null,
    file: null,
    task: null,
    away: false,
    tokens: null,
    waiting: null,
    stalledSince: null,
    toolSince: null,
    openTool: null,
    context: null,
  };
}

function floor(slug: string, kind: FloorView['kind']): FloorView {
  return { slug, label: slug, path: null, stack: 'generic', kind, building: 'principal' };
}

const order = (key: string): number => ['lead-1', 'dev-1', 'dev-2', 'red-1'].indexOf(key);

function building() {
  const upper = computeFloorLayout(floor('mobile', 'managed'), [agent('lead-1', 'lead', 'mobile'), agent('dev-1', 'dev', 'mobile', 'lead-1')], WIDTH, order);
  const ground = computeFloorLayout(floor('redaccion', 'redaccion'), [agent('red-1', 'writer', 'redaccion')], WIDTH, order);
  return { upper, upperTop: 0, ground, groundTop: upper.height + FLOOR_GAP };
}

describe('leaving the 2D office', () => {
  const PATH_DY = 26;

  test('from an upper floor: lift down, out through the garden door, along the path to the car', () => {
    const { upper, upperTop, ground, groundTop } = building();
    const door = gardenDoor(ground, groundTop);
    const pathY = door.y + PATH_DY;
    const spot = { x: 60, y: pathY + 22 };
    const route = liftRoute(
      liftGate(upper, upperTop, 'mobile'),
      liftGate(ground, groundTop, 'redaccion'),
      ...gardenRoute(liftGate(ground, groundTop, 'redaccion'), door, pathY, spot).slice(1),
    );
    expect(route).toEqual([
      liftGate(upper, upperTop, 'mobile'),
      liftGate(ground, groundTop, 'redaccion'),
      door,
      { x: door.x, y: pathY },
      { x: spot.x, y: pathY },
      spot,
    ]);
    expect(door.y).toBeGreaterThan(groundTop + ground.height);
    expect(route[0]!.floor).toBe('mobile');
    expect(route[1]!.floor).toBe('redaccion');
    expect(route.slice(2).every((point) => point.floor === undefined)).toBe(true);
    expect(liftLeg(route, () => true)).toEqual({ from: 'mobile', to: 'redaccion', fromFace: 'room', toFace: 'room', approach: true });
  });

  test('from the ground floor the lift door is passed once and no ride is taken', () => {
    const { ground, groundTop } = building();
    const door = gardenDoor(ground, groundTop);
    const spot = { x: 60, y: door.y + 40 };
    const gate = liftGate(ground, groundTop, 'redaccion');
    const route = liftRoute(gate, gate, door, spot);
    expect(route).toEqual([gate, door, spot]);
    expect(liftRoute(null, gate, door, spot)).toEqual([gate, door, spot]);
    expect(liftLeg(route, () => true)).toBeNull();
  });

  test('an agent arriving walks up the path, through the garden door, and rides up to its desk', () => {
    const { upper, upperTop, ground, groundTop } = building();
    const desk = upper.desks.get('dev-1')!;
    const goal = { x: desk.x, y: upperTop + desk.y };
    const door = gardenDoor(ground, groundTop);
    const pathY = door.y + PATH_DY;
    const from = { x: WIDTH + 16, y: pathY };
    const groundGate = liftGate(ground, groundTop, 'redaccion');
    const route = [...gardenArrival(from, door, pathY, groundGate), ...liftRoute(groundGate, liftGate(upper, upperTop, 'mobile'), goal).slice(1)];
    expect(route).toEqual([{ x: door.x, y: pathY }, door, groundGate, liftGate(upper, upperTop, 'mobile'), goal]);
    expect(route[0]!.y).toBe(pathY);
    expect(route.filter((point) => point.x === groundGate.x && point.y === groundGate.y)).toHaveLength(1);
    expect(liftLeg(route.slice(2), () => true)).toMatchObject({ from: 'redaccion', to: 'mobile' });
    expect(liftLeg(route.slice(2), () => false)).toBeNull();
  });

  test('coming back from a parking bay climbs to the path before heading for the door', () => {
    const { ground, groundTop } = building();
    const door = gardenDoor(ground, groundTop);
    const pathY = door.y + PATH_DY;
    const bay = { x: 300, y: pathY + 22 };
    expect(gardenArrival(bay, door, pathY, liftGate(ground, groundTop))[0]).toEqual({ x: bay.x, y: pathY });
  });

  test('an agent left out of the layout frees its desk', () => {
    const agents = [agent('lead-1', 'lead', 'mobile'), agent('dev-1', 'dev', 'mobile', 'lead-1'), agent('dev-2', 'dev', 'mobile', 'lead-1')];
    const full = computeFloorLayout(floor('mobile', 'managed'), agents, WIDTH, order);
    const without = computeFloorLayout(floor('mobile', 'managed'), [agents[0]!, agents[2]!], WIDTH, order);
    expect(full.desks.size).toBe(3);
    expect(without.desks.has('dev-1')).toBe(false);
    expect(without.desks.size).toBe(2);
    expect(without.desks.get('dev-2')).toEqual(full.desks.get('dev-1'));
  });
});

describe('the coffee machine', () => {
  test('has two places below the machine, side by side', () => {
    const layout = computeFloorLayout(floor('mobile', 'managed'), [agent('lead-1', 'lead', 'mobile')], WIDTH, order);
    expect(layout.coffeeStands).toHaveLength(2);
    const [left, right] = layout.coffeeStands;
    expect(right.x - left.x).toBeGreaterThan(10);
    expect(left.y).toBe(right.y);
    expect(left.y).toBeGreaterThan(layout.coffee.y + 24);
    expect(left.x).toBeGreaterThan(layout.coffee.x - 8);
    expect(right.x).toBeLessThan(layout.coffee.x + 30);
  });
});


describe('the layout override in 2D', () => {
  const lead = agent('lead-1', 'lead', 'mobile');
  const devs = [agent('dev-1', 'dev', 'mobile', 'lead-1'), agent('dev-2', 'dev', 'mobile', 'lead-1')];
  const mobile = floor('mobile', 'managed');
  const layout = (override?: Parameters<typeof computeFloorLayout>[4]) => computeFloorLayout(mobile, [lead, ...devs], WIDTH, order, override);
  const areaTop = WALL_H + 8;

  test('with no override, or one that moves nothing, the output is identical', () => {
    const plain = layout();
    for (const nothing of [{}, { desks: [null, null] }, { furniture: {} }, { characters: { dev: 'quaternius/punk.glb' } }]) {
      expect(layout(nothing)).toEqual(plain);
    }
    expect(plain.boardShift).toBe(0);
    expect(plain.coffee).toEqual({ x: WIDTH - UTIL_W + 70, y: WALL_H - 22 });
    expect(plain.labBench).toEqual({ x: WIDTH - UTIL_W + 4, y: WALL_H - 18 });
    expect(plain.rug).toEqual({ x: WIDTH - UTIL_W + 4, y: 66, w: 92, h: 52 });
    expect(plain.height).toBe(MIN_FLOOR_H);
  });

  test('a desk goes to the nearest of two rows, and the floor grows with the lower one', () => {
    const base = layout();
    const moved = layout({ desks: [{ u: 0.6, v: 0.6 }] });
    const slot = moved.desks.get('dev-1')!;
    expect(slot.x).toBe(Math.round(0.6 * WIDTH - slot.width / 2));
    expect(slot.y).toBeCloseTo(areaTop + ROW_H + (1 - slot.scale) * SLOT_H, 5);
    expect(moved.desks.get('dev-2')).toEqual(base.desks.get('dev-2'));
    expect(moved.height).toBeGreaterThan(base.height);
    const upper = layout({ desks: [{ u: 0.6, v: 0.1 }] });
    expect(upper.desks.get('dev-1')!.y).toBeCloseTo(areaTop + (1 - slot.scale) * SLOT_H, 5);
    expect(upper.height).toBe(base.height);
    expect(rowOf(0.2)).toBe(0);
    expect(rowOf(0.5)).toBe(1);
  });

  test('a desk that would overlap another one stays where the grid put it', () => {
    const base = layout();
    const target = base.desks.get('dev-2')!;
    const onTop = layout({ desks: [{ u: (target.x + 6 + target.width / 2) / WIDTH, v: 0.2 }] });
    expect(onTop.desks.get('dev-1')).toEqual(base.desks.get('dev-1'));
    const sameSpot = { u: 0.6, v: 0.6 };
    const both = layout({ desks: [sameSpot, sameSpot] });
    expect(both.desks.get('dev-1')!.x).toBe(Math.round(0.6 * WIDTH - 16));
    expect(both.desks.get('dev-2')).toEqual(base.desks.get('dev-2'));
  });

  test('a desk stays inside the floor and out of the utility zone', () => {
    const edge = layout({ desks: [{ u: 0, v: 0.6 }, { u: 1, v: 0.6 }] });
    expect(edge.desks.get('dev-1')!.x).toBeGreaterThanOrEqual(MARGIN);
    const right = edge.desks.get('dev-2')!;
    expect(right.x + right.width).toBeLessThanOrEqual(WIDTH - UTIL_W - MARGIN);
  });

  test('the lead desk moves too, along its row', () => {
    const moved = layout({ lead: { u: 0.5, v: 0.9 } });
    expect(moved.leadDesk).not.toBeNull();
    expect(moved.leadDesk!.x).toBe(Math.round(0.5 * WIDTH - moved.leadDesk!.width / 2));
    expect(moved.leadDesk!.y).toBe(areaTop);
    expect(moved.desks.get('lead-1')).toBe(moved.leadDesk!);
  });

  test('the coffee machine, the lab bench and the board slide along the wall; the table moves on the floor', () => {
    const base = layout();
    const moved = layout({ furniture: { coffee: { u: 0.2, v: 0.9 }, lab: { u: 0.3, v: 0.9 }, board: { u: 0.4, v: 0.9 }, meeting: { u: 0.5, v: 0.8 } } });
    expect(moved.coffee).toEqual({ x: Math.round(0.2 * WIDTH - 8) , y: base.coffee.y });
    expect(moved.coffeeStands.map((point) => point.x)).toEqual(moved.coffeeStands.map((_, index) => moved.coffee.x + [-2, 18][index]!));
    expect(moved.labBench).toEqual({ x: Math.round(0.3 * WIDTH - 29), y: base.labBench.y });
    expect(moved.labStands[0]!.x - moved.labBench.x).toBe(base.labStands[0]!.x - base.labBench.x);
    expect(moved.boardShift).toBe(Math.round(0.4 * WIDTH - (WIDTH - UTIL_W - 4 - 30.5)));
    expect(moved.rug.x + 46).toBe(Math.round(0.5 * WIDTH));
    expect(moved.rug.y).toBeGreaterThan(base.rug.y);
    expect(moved.table).toEqual({ x: moved.rug.x + 24, y: moved.rug.y + 14 });
    expect(moved.seats[0]!.x - moved.table.x).toBe(base.seats[0]!.x - base.table.x);
  });
});
