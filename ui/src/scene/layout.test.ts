import { describe, expect, test } from 'bun:test';
import type { AgentView, FloorView } from '../types';
import {
  AISLE_Z,
  BRIDGE_LANDING_DX,
  COFFEE_DX,
  COFFEE_Z,
  DEPTH,
  HALF_D,
  LAB_BENCH_DX,
  LEAD_DESK_DX,
  LEAD_DESK_Z,
  LEAD_LANE_DX,
  LEAD_STAND_OFFSET,
  LIFT_GAP,
  LIFT_W,
  MEET_DX,
  MEET_Z,
  PARK_AISLE_Z,
  PITCH,
  PRINTER_DX,
  PRINTER_Z,
  ROAD_Z,
  ROW_DESK_Z,
  STAND_OFFSET,
  STOREY_H,
  WALL_T,
} from './constants';
import {
  STREET,
  STREET_DX,
  coffeeTarget,
  computeFloorPlan,
  deskTarget,
  exitTarget,
  furnitureDefaults,
  furniturePlaced,
  furnitureShifts,
  labTarget,
  liftLeg,
  meetingTarget,
  MIN_DESK_GAP,
  NO_SHIFTS,
  planPath,
  servesLift,
  spotToWorld,
  streetNav,
  streetPoint,
  worldToSpot,
  type FloorNav,
  type Nav,
  type Waypoint,
} from './layout';

const MAIN_W = 20;
const ANNEX_W = 12;

function agent(key: string, roleKind: AgentView['roleKind'], parentKey: string | null = null): AgentView {
  return {
    key,
    sessionId: 's-1',
    parentKey,
    name: key,
    role: null,
    roleId: null,
    roleKind,
    floor: 'mobile',
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
    context: null,
  };
}

const MOBILE: FloorView = { slug: 'mobile', label: 'mobile', path: '/m', stack: 'flutter', kind: 'managed', building: 'principal' };

function nav(): Nav {
  const floors = new Map<string, FloorNav>();
  const mainExit = MAIN_W / 2 + LIFT_GAP + LIFT_W / 2;
  const annexExit = -ANNEX_W / 2 - WALL_T - 0.7;
  floors.set('direccion', { slug: 'direccion', building: 'main', level: 2, width: MAIN_W, exitX: mainExit });
  floors.set('mobile', { slug: 'mobile', building: 'main', level: 1, width: MAIN_W, exitX: mainExit });
  floors.set('redaccion', { slug: 'redaccion', building: 'main', level: 0, width: MAIN_W, exitX: mainExit });
  floors.set('mantenimiento', { slug: 'mantenimiento', building: 'annex', level: 0, width: ANNEX_W, exitX: annexExit });
  floors.set('taller', { slug: 'taller', building: 'annex', level: 1, width: ANNEX_W, exitX: annexExit });
  floors.set(STREET, streetNav(floors.get('redaccion')!));
  return { floors, mainGround: 'redaccion', annexGround: 'mantenimiento' };
}

function floorsOf(path: readonly Waypoint[]): string[] {
  return path.map((point) => point.floor).filter((floor, index, all) => index === 0 || all[index - 1] !== floor);
}

describe('the street', () => {
  test('the exit is on the sidewalk past the ground floor lift, outside the building', () => {
    const map = nav();
    const exit = exitTarget(map)!;
    const ground = map.floors.get('redaccion')!;
    expect(exit).toMatchObject({ kind: 'exit', floor: STREET, x: ground.exitX + STREET_DX, lane: ground.exitX });
    expect(exit.z).toBeGreaterThan(HALF_D);
    expect(map.floors.get(STREET)).toMatchObject({ level: 0, building: 'main' });
    expect(streetPoint(map)).toEqual({ floor: STREET, x: ground.exitX, z: ROAD_Z - 1, lane: ground.exitX });
  });

  test('without a ground floor there is no street', () => {
    const empty: Nav = { floors: new Map(), mainGround: null, annexGround: null };
    expect(exitTarget(empty)).toBeNull();
    expect(streetPoint(empty)).toBeNull();
  });

  test('from a desk upstairs: aisle, lift down at exitX, out to the sidewalk', () => {
    const map = nav();
    const plan = computeFloorPlan(MOBILE, [agent('dev-1', 'dev')], MAIN_W, 3, () => 0);
    const desk = deskTarget('mobile', plan.assignment.get('dev-1')!);
    const exit = exitTarget(map)!;
    const path = planPath({ floor: 'mobile', x: desk.x, z: desk.z, lane: desk.lane }, exit, map)!;
    expect(floorsOf(path)).toEqual(['mobile', STREET]);
    const exitX = map.floors.get('mobile')!.exitX;
    const leaveFloor = path.findLast((point) => point.floor === 'mobile')!;
    expect(leaveFloor).toMatchObject({ x: exitX, z: AISLE_Z });
    const firstStreet = path.find((point) => point.floor === STREET)!;
    expect(firstStreet).toMatchObject({ x: exitX, z: AISLE_Z });
    expect(path.at(-1)).toMatchObject({ floor: STREET, x: exit.x, z: exit.z });
  });

  test('from the annex: stairs, corridor to the main ground floor, then out', () => {
    const map = nav();
    const exit = exitTarget(map)!;
    const path = planPath({ floor: 'taller', x: 0, z: AISLE_Z, lane: null }, exit, map)!;
    expect(floorsOf(path)).toEqual(['taller', 'mantenimiento', 'redaccion', STREET]);
    expect(path.at(-1)).toMatchObject({ floor: STREET, x: exit.x, z: exit.z });
  });

  test('an agent arriving walks from the street to its desk through the lift', () => {
    const map = nav();
    const plan = computeFloorPlan(MOBILE, [agent('dev-1', 'dev')], MAIN_W, 3, () => 0);
    const desk = deskTarget('mobile', plan.assignment.get('dev-1')!);
    const path = planPath(streetPoint(map)!, desk, map)!;
    expect(floorsOf(path)).toEqual([STREET, 'mobile']);
    const lift = path.findLast((point) => point.floor === STREET)!;
    expect(lift).toMatchObject({ x: map.floors.get(STREET)!.exitX, z: AISLE_Z });
    expect(path.filter((point) => point.floor === STREET).every((point) => point.x === lift.x)).toBe(true);
    expect(path.at(-1)).toMatchObject({ floor: 'mobile', x: desk.x, z: desk.z });
  });

  test('going home to a parking spot: out through the tower door, down the garden path, along the aisle', () => {
    const map = nav();
    const ground = map.floors.get('redaccion')!;
    const spot = { x: 3.1, z: PARK_AISLE_Z };
    const exit = exitTarget(map, spot)!;
    expect(exit).toMatchObject({ kind: 'exit', floor: STREET, x: spot.x, z: spot.z, lane: ground.exitX });
    const plan = computeFloorPlan(MOBILE, [agent('dev-1', 'dev')], MAIN_W, 3, () => 0);
    const desk = deskTarget('mobile', plan.assignment.get('dev-1')!);
    const path = planPath({ floor: 'mobile', x: desk.x, z: desk.z, lane: desk.lane }, exit, map)!;
    const street = path.filter((point) => point.floor === STREET);
    expect(street[0]).toMatchObject({ x: ground.exitX, z: AISLE_Z });
    expect(street.at(-2)).toMatchObject({ x: ground.exitX, z: PARK_AISLE_Z });
    expect(path.at(-1)).toMatchObject({ floor: STREET, x: spot.x, z: spot.z });
  });
});

describe('the lift', () => {
  const stops = new Map<string, number>([
    ['direccion', 0.35 + 2 * STOREY_H],
    ['mobile', 0.35 + STOREY_H],
    ['redaccion', 0.35],
    [STREET, 0.35],
  ]);

  test('serves the floors of the main building and the street, not the annex', () => {
    const map = nav();
    expect(servesLift('mobile', STREET, map, stops)).toBe(true);
    expect(servesLift('redaccion', STREET, map, stops)).toBe(false);
    expect(servesLift('taller', 'mantenimiento', map, stops)).toBe(false);
    expect(servesLift('mantenimiento', 'redaccion', map, stops)).toBe(false);
    expect(servesLift('redaccion', 'direccion', map, stops)).toBe(true);
  });

  test('from the annex: no ride on the stairs, a ride from the bridge landing up to the top floor', () => {
    const map = nav();
    const plan = computeFloorPlan(MOBILE, [agent('dev-1', 'dev')], MAIN_W, 3, () => 0);
    const desk = deskTarget('direccion', plan.assignment.get('dev-1')!);
    const path = planPath({ floor: 'taller', x: 0, z: AISLE_Z, lane: null }, desk, map)!;
    const atAnnex = path.findIndex((point) => point.floor === 'mantenimiento');
    expect(liftLeg(path[atAnnex]!, path.slice(atAnnex + 1), map, stops, false)).toBeNull();
    const toMain = path.findIndex((point) => point.floor === 'redaccion');
    const exitX = map.floors.get('redaccion')!.exitX;
    const landing = { floor: 'redaccion', x: exitX + BRIDGE_LANDING_DX, z: AISLE_Z, lane: null };
    expect(liftLeg(landing, path.slice(toMain + 1), map, stops, true)).toEqual({
      from: 'redaccion',
      to: 'direccion',
      fromFace: 'bridge',
      toFace: 'room',
      approach: false,
    });
  });

  test('to the annex: approach on the top floor and leave through the bridge face', () => {
    const map = nav();
    const back = planPath({ floor: 'direccion', x: 2, z: AISLE_Z, lane: null }, { id: 'x', kind: 'desk', floor: 'taller', x: 0, z: 0, lane: 0, facing: 0, slot: null }, map)!;
    expect(back[0]).toMatchObject({ floor: 'direccion', x: map.floors.get('direccion')!.exitX, z: AISLE_Z });
    expect(liftLeg({ floor: 'direccion', x: 2, z: AISLE_Z, lane: null }, back, map, stops, false)).toEqual({
      from: 'direccion',
      to: 'redaccion',
      fromFace: 'room',
      toFace: 'bridge',
      approach: true,
    });
  });

  test('going home from upstairs leaves the cabin through the street face', () => {
    const map = nav();
    const exit = exitTarget(map, { x: 3, z: PARK_AISLE_Z })!;
    const from = { floor: 'mobile', x: 1, z: AISLE_Z, lane: null };
    const path = planPath(from, exit, map)!;
    expect(liftLeg(from, path, map, stops, false)).toMatchObject({ from: 'mobile', to: STREET, fromFace: 'room', toFace: 'street', approach: true });
  });
});

describe('desks', () => {
  test('an agent left out of the plan frees its desk', () => {
    const lead = agent('lead-1', 'lead');
    const devs = [agent('dev-1', 'dev', 'lead-1'), agent('dev-2', 'dev', 'lead-1')];
    const order = (key: string): number => ['lead-1', 'dev-1', 'dev-2'].indexOf(key);
    const full = computeFloorPlan(MOBILE, [lead, ...devs], MAIN_W, 3, order);
    expect(full.slots).toHaveLength(2);
    const without = computeFloorPlan(MOBILE, [lead, devs[1]!], MAIN_W, 3, order);
    expect(without.assignment.has('dev-1')).toBe(false);
    expect(without.slots).toHaveLength(1);
    expect(without.assignment.get('dev-2')).toEqual(full.assignment.get('dev-1'));
    expect(without.assignment.get('lead-1')).toEqual(full.assignment.get('lead-1'));
  });
});

describe('the coffee machine', () => {
  test('has two places in front of the counter that face each other', () => {
    const first = coffeeTarget('mobile', MAIN_W, 0);
    const second = coffeeTarget('mobile', MAIN_W, 1);
    expect(first).toMatchObject({ kind: 'coffee', floor: 'mobile', id: 'coffee:mobile:0', slot: null });
    expect(second.id).toBe('coffee:mobile:1');
    expect(first.z).toBe(second.z);
    expect(first.z).toBeGreaterThan(COFFEE_Z);
    expect(first.z).toBeLessThan(AISLE_Z);
    expect(second.x - first.x).toBeGreaterThan(0.5);
    expect(second.x - first.x).toBeLessThan(1.2);
    expect(Math.abs(first.x - (MAIN_W / 2 - COFFEE_DX))).toBeLessThan(1);
    expect(first.facing).toBeCloseTo(Math.PI / 2, 5);
    expect(second.facing).toBeCloseTo(-Math.PI / 2, 5);
    expect(first.lane).toBe(first.x);
  });

  test('a seat outside the two wraps around, and the path to it goes by the aisle', () => {
    expect(coffeeTarget('mobile', MAIN_W, 2).id).toBe('coffee:mobile:0');
    expect(coffeeTarget('mobile', MAIN_W, -1).id).toBe('coffee:mobile:1');
    const map = nav();
    const target = coffeeTarget('mobile', MAIN_W, 1);
    const path = planPath({ floor: 'mobile', x: 0, z: -2.25, lane: 1 }, target, map)!;
    expect(path.some((point) => Math.abs(point.z - AISLE_Z) < 0.02)).toBe(true);
    expect(path[path.length - 1]).toMatchObject({ floor: 'mobile', x: target.x, z: target.z });
    expect(floorsOf(path)).toEqual(['mobile']);
  });
});


describe('the layout override', () => {
  const lead = agent('lead-1', 'lead');
  const devs = [agent('dev-1', 'dev', 'lead-1'), agent('dev-2', 'dev', 'lead-1'), agent('dev-3', 'dev', 'lead-1')];
  const order = (key: string): number => ['lead-1', 'dev-1', 'dev-2', 'dev-3'].indexOf(key);
  const plan = (override?: Parameters<typeof computeFloorPlan>[5]) => computeFloorPlan(MOBILE, [lead, ...devs], MAIN_W, 3, order, override);
  const half = MAIN_W / 2;

  test('with no override, or one that moves nothing, the output is identical', () => {
    const plain = plan();
    for (const nothing of [{}, { desks: [null, null, null] }, { furniture: {} }, { characters: { dev: 'quaternius/punk.glb' } }]) {
      const same = plan(nothing);
      expect(same.slots).toEqual(plain.slots);
      expect(same.leadSlot).toEqual(plain.leadSlot);
      expect([...same.assignment]).toEqual([...plain.assignment]);
    }
    expect(furnitureShifts(MOBILE, MAIN_W)).toBe(NO_SHIFTS);
    expect(furnitureShifts(MOBILE, MAIN_W, { desks: [{ u: 0.5, v: 0.5 }] })).toBe(NO_SHIFTS);
    expect(labTarget('mobile', MAIN_W, 4)).toEqual(labTarget('mobile', MAIN_W, 4, NO_SHIFTS.lab));
    expect(meetingTarget('mobile', MAIN_W, 3)).toEqual(meetingTarget('mobile', MAIN_W, 3, NO_SHIFTS.meeting));
    expect(coffeeTarget('mobile', MAIN_W, 1)).toEqual(coffeeTarget('mobile', MAIN_W, 1, NO_SHIFTS.coffee));
  });

  test('the default places of the furniture are the ones the room has always had', () => {
    const placed = furniturePlaced(MOBILE, MAIN_W);
    expect(placed.coffee).toEqual({ x: half - COFFEE_DX, z: COFFEE_Z });
    expect(placed.meeting).toEqual({ x: half - MEET_DX, z: MEET_Z });
    expect(placed.lab).toEqual({ x: half - LAB_BENCH_DX, z: -HALF_D + 0.36 });
    expect(placed.board).toEqual({ x: half - 3.2, z: -HALF_D + 0.03 });
    expect(placed.printer).toEqual({ x: half - PRINTER_DX, z: PRINTER_Z });
    const direction: FloorView = { ...MOBILE, slug: 'direccion', kind: 'direccion' };
    expect(furnitureDefaults(direction, MAIN_W).board.x).toBe(-half + LEAD_DESK_DX - 0.2);
    expect(labTarget('mobile', MAIN_W, 1)).toMatchObject({ x: half - 5.5, lane: half - 7.15 });
  });

  test('a desk goes where the user put it, on the nearest row, with its stand and lane', () => {
    const moved = plan({ desks: [{ u: 0.75, v: 0.05 }, null, { u: 0.8, v: 0.9 }] });
    const [first, second, third] = moved.slots;
    expect(first.x).toBeCloseTo(-half + 0.75 * MAIN_W, 5);
    expect(first.z).toBe(ROW_DESK_Z[0]);
    expect(first.standX).toBe(first.x);
    expect(first.standZ).toBeCloseTo(first.z - STAND_OFFSET * first.scale, 5);
    expect(first.lane).toBeCloseTo(first.x + PITCH / 2, 5);
    expect(second).toEqual(plan().slots[1]);
    expect(third.x).toBeCloseTo(-half + 0.8 * MAIN_W, 5);
    expect(third.z).toBe(ROW_DESK_Z[1]);
    expect(moved.assignment.get('dev-1')).toBe(first);
  });

  test('a child desk keeps its scale when it moves', () => {
    const grandchild = agent('dev-4', 'dev', 'dev-1');
    const tree = computeFloorPlan(MOBILE, [lead, devs[0]!, grandchild], MAIN_W, 3, (key) => ['lead-1', 'dev-1', 'dev-4'].indexOf(key), { desks: [null, { u: 0.6, v: 0.6 }] });
    const child = tree.slots[1]!;
    expect(child.kind).toBe('child');
    expect(child.z).toBe(ROW_DESK_Z[1]);
    expect(child.standZ).toBeCloseTo(child.z - STAND_OFFSET * child.scale, 5);
  });

  test('the lead moves along its row, and a desk may not sit on it', () => {
    const base = plan();
    const moved = plan({ lead: { u: 0.5, v: 0.5 } });
    expect(moved.leadSlot!.x).toBeCloseTo(0, 5);
    expect(moved.leadSlot!.z).toBe(ROW_DESK_Z[1]);
    expect(moved.leadSlot!.lane).toBeCloseTo(moved.leadSlot!.x + (LEAD_LANE_DX - LEAD_DESK_DX), 5);
    expect(moved.leadSlot!.standZ).toBeCloseTo(moved.leadSlot!.z - LEAD_STAND_OFFSET, 5);
    expect(base.leadSlot!.z).toBe(LEAD_DESK_Z);
    const upper = plan({ lead: { u: 0.2, v: 0.28 } });
    expect(upper.leadSlot!.z).toBe(LEAD_DESK_Z);
    const crowded = plan({ lead: { u: 0.5, v: 0.5 }, desks: [{ u: 0.5, v: 0.5 }] });
    expect(crowded.leadSlot!.x).toBeCloseTo(0, 5);
    expect(crowded.slots[0]).toEqual(base.slots[0]);
  });

  test('a desk that would overlap another goes back to the grid', () => {
    const base = plan();
    const target = { u: (base.slots[1]!.x + half + MIN_DESK_GAP - 0.1) / MAIN_W, v: 0.2 };
    const onTop = plan({ desks: [target] });
    expect(onTop.slots[0]).toEqual(base.slots[0]);
    const clear = plan({ desks: [{ u: 0.65, v: 0.2 }] });
    expect(clear.slots[0]!.x).toBeCloseTo(-half + 0.65 * MAIN_W, 5);
    const onLead = plan({ desks: [{ u: (base.leadSlot!.x + half) / MAIN_W, v: 0.28 }] });
    expect(onLead.slots[0]).toEqual(base.slots[0]);
  });

  test('two desks cannot be moved to the same place: the first wins, the second goes back', () => {
    const base = plan();
    const spot = { u: 0.5, v: 0.5 };
    const both = plan({ desks: [spot, spot] });
    expect(both.slots[0]!.x).toBeCloseTo(0, 5);
    expect(both.slots[1]).toEqual(base.slots[1]);
  });

  test('a desk stays inside the room', () => {
    const edge = plan({ desks: [{ u: 0, v: 0.5 }, { u: 1, v: 0.5 }] });
    expect(edge.slots[0]!.x).toBeGreaterThanOrEqual(-half + 0.5);
    expect(edge.slots[1]!.x).toBeLessThanOrEqual(half - 0.5);
  });

  test('furniture moves with its stands: the coffee machine, the lab and the table take their targets along', () => {
    const spot = { u: 0.3, v: 0.5 };
    const override = { furniture: { coffee: spot, lab: spot, meeting: spot } };
    const placed = furniturePlaced(MOBILE, MAIN_W, override);
    const target = spotToWorld(spot, MAIN_W);
    for (const kind of ['coffee', 'meeting', 'lab'] as const) {
      expect(placed[kind].x).toBeCloseTo(target.x, 5);
      expect(placed[kind].z).toBeCloseTo(target.z, 5);
    }
    expect(placed.printer).toEqual(furniturePlaced(MOBILE, MAIN_W).printer);
    const shifts = furnitureShifts(MOBILE, MAIN_W, override);
    const home = coffeeTarget('mobile', MAIN_W, 0);
    const moved = coffeeTarget('mobile', MAIN_W, 0, shifts.coffee);
    expect(moved.x - home.x).toBeCloseTo(shifts.coffee.dx, 5);
    expect(moved.z - home.z).toBeCloseTo(shifts.coffee.dz, 5);
    expect(moved.lane).toBe(moved.x);
    expect(labTarget('mobile', MAIN_W, 0, shifts.lab).lane - labTarget('mobile', MAIN_W, 0).lane).toBeCloseTo(shifts.lab.dx, 5);
    expect(meetingTarget('mobile', MAIN_W, 2, shifts.meeting).z - meetingTarget('mobile', MAIN_W, 2).z).toBeCloseTo(shifts.meeting.dz, 5);
  });

  test('the whiteboard slides along the back wall and never leaves it; furniture stays inside the room', () => {
    const board = furniturePlaced(MOBILE, MAIN_W, { furniture: { board: { u: 0.5, v: 0.9 } } }).board;
    expect(board.x).toBeCloseTo(0, 5);
    expect(board.z).toBe(furnitureDefaults(MOBILE, MAIN_W).board.z);
    const corner = furniturePlaced(MOBILE, MAIN_W, { furniture: { coffee: { u: 1, v: 1 }, printer: { u: 0, v: 0 } } });
    expect(corner.coffee.x).toBeLessThanOrEqual(half);
    expect(corner.coffee.z).toBeLessThan(HALF_D);
    expect(corner.printer.x).toBeGreaterThan(-half);
    expect(corner.printer.z).toBeGreaterThan(-HALF_D);
  });

  test('spots convert to metres and back', () => {
    const spot = { u: 0.25, v: 0.75 };
    const world = spotToWorld(spot, MAIN_W);
    expect(world).toEqual({ x: -half + 0.25 * MAIN_W, z: -HALF_D + 0.75 * DEPTH });
    expect(worldToSpot(world.x, world.z, MAIN_W)).toEqual(spot);
    expect(worldToSpot(-100, 100, MAIN_W)).toEqual({ u: 0, v: 1 });
  });

  test('the path to a moved desk still goes by the aisle', () => {
    const moved = plan({ desks: [{ u: 0.5, v: 0.1 }] });
    const slot = moved.slots[0]!;
    const path = planPath({ floor: 'mobile', x: 3, z: AISLE_Z, lane: null }, deskTarget('mobile', slot), nav())!;
    expect(path.some((point) => Math.abs(point.x - slot.lane) < 0.02 && Math.abs(point.z - AISLE_Z) < 0.02)).toBe(true);
    expect(path[path.length - 1]).toMatchObject({ x: slot.standX, z: slot.standZ });
  });
});
