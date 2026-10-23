import { Application, Container, Graphics } from 'pixi.js';
import { ambient, coffeePlan, daylightFor, type CoffeeVisit } from '../ambient';
import { effectiveTheme, theme } from '../theme';
import { paletteRole, resolveOverride } from '../layouts';
import { LiftController, linkLift } from '../lift';
import { contextOf } from '../labels';
import type { Store } from '../store';
import { boardData, boardInputFor } from '../boards';
import type { Tab } from '../topbar';
import type { AgentView, FloorLayoutOverride, FloorView, UsageSummary } from '../types';
import { mountUsageCard } from '../usage-card';
import { Backdrop } from './backdrop';
import { CharacterView, type Target } from './character-view';
import {
  DESK_FEET_Y,
  DESK_SEAT_X,
  FLOOR_GAP,
  GARDEN_H,
  LANDING_DX,
  LEAD_SEAT_X,
  LIFT_DOOR_S,
  LIFT_DWELL_S,
  LIFT_MAX_DWELL_S,
  LIFT_SPEED_2D,
  MEETING_REFRESH_S,
  MIN_WIDTH,
  SCALE,
  SIDE_MARGIN,
  SKY_H,
  SLOT_W,
  WALL_H,
} from './constants';
import { FloorScene } from './floor-scene';
import { buildDesk, type DeskParts } from './furniture';
import { GardenScene } from './garden';
import {
  computeFloorLayout,
  gardenArrival,
  gardenDoor,
  gardenRoute,
  liftCenter,
  liftGate,
  liftRoute,
  type DeskSlot,
  type Point,
} from './layout';
import { LiftCabin } from './lift-cabin';
import { findMeetingPairs } from './meetings';
import { floorPalette, hashString } from './palette';

type Entry = {
  view: CharacterView;
  agent: AgentView;
  scale: number;
  look: string;
  ownDesk: DeskParts | null;
  desk: DeskParts | null;
  slot: DeskSlot | null;
  goalScene: FloorScene | null;
};

type MeetingSeat = { floor: string; seat: number };

const TALK_LINE_COLOR = 0xf472b6;
const HEAD_HEIGHT = 20;
const FALLBACK_BACKGROUND = '#0b0e12';
const DARK_CHECK_S = 10;

export type OfficeHandle = { setActive(active: boolean): void; focusAgent(key: string): void; focusFloor(slug: string): void };

export type OfficeHooks = { openTab(tab: Tab): void; usageToday(): UsageSummary | null };

function accentCss(floor: FloorView): string {
  return `#${floorPalette(floor).accent.toString(16).padStart(6, '0')}`;
}

function canvasBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim();
  return value || FALLBACK_BACKGROUND;
}

function dashedLine(g: Graphics, from: Point, to: Point, phase: number, color: number): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return;
  const ux = dx / length;
  const uy = dy / length;
  const dash = 4;
  const period = dash + 3;
  let position = -((phase * 12) % period);
  while (position < length) {
    const start = Math.max(0, position);
    const end = Math.min(length, position + dash);
    if (end > start) g.moveTo(from.x + ux * start, from.y + uy * start).lineTo(from.x + ux * end, from.y + uy * end);
    position += period;
  }
  g.stroke({ width: 1, color, alpha: 0.9 });
}

class OfficeView {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly backgrounds = new Container();
  private readonly actors = new Container();
  private readonly foregrounds = new Container();
  private readonly lines = new Graphics();
  private readonly scrollbar = new Graphics();
  private readonly scenes = new Map<string, FloorScene>();
  private readonly entries = new Map<string, Entry>();
  private readonly firstSeen = new Map<string, number>();
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly backdrop = new Backdrop();
  private readonly garden = new GardenScene(this.backgrounds, this.actors);
  private readonly cabin = new LiftCabin(this.actors);
  private readonly lift = new LiftController({ speed: LIFT_SPEED_2D, doorTime: LIFT_DOOR_S, dwell: LIFT_DWELL_S, maxDwell: LIFT_MAX_DWELL_S });
  private readonly liftLink = linkLift<Point>(this.lift, {
    serves: (from, to) => from !== to && this.scenes.has(from) && this.scenes.has(to),
    landing: (floor) => {
      const scene = this.scenes.get(floor) ?? this.ground();
      return scene ? { x: scene.layout.lift.x - LANDING_DX, y: scene.top + scene.layout.walkY } : { x: 0, y: 0 };
    },
    cabin: (floor) => {
      const scene = this.scenes.get(floor) ?? this.ground();
      return scene ? liftGate(scene.layout, scene.top) : { x: 0, y: 0 };
    },
  });
  private gardenTop = SKY_H;
  private backdropKey = '';
  private sceneOrder: FloorScene[] = [];
  private meetings = new Map<string, MeetingSeat>();
  private coffee = new Map<string, CoffeeVisit>();
  private dark = false;
  private darkTimer = 0;
  private seenCounter = 0;
  private primed = false;
  private scrollY = 0;
  private worldHeight = 0;
  private logicalWidth = MIN_WIDTH;
  private elapsed = 0;
  private meetingTimer = 0;
  private dirty = true;

  constructor(
    private readonly store: Store,
    private readonly hooks: OfficeHooks,
  ) {}

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: canvasBackground(),
      antialias: false,
      resolution: window.devicePixelRatio,
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    host.appendChild(mountUsageCard(this.store).root);

    this.actors.sortableChildren = true;
    this.world.scale.set(SCALE);
    this.world.addChild(this.backgrounds, this.actors, this.foregrounds, this.lines);
    this.backgrounds.addChildAt(this.backdrop.root, 0);
    this.app.stage.addChild(this.world, this.scrollbar);

    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.media.addEventListener('change', () => {
      this.app.renderer.background.color = canvasBackground();
      this.dirty = true;
    });
    theme.subscribe(() => {
      this.app.renderer.background.color = canvasBackground();
      this.dirty = true;
    });
    ambient.subscribe(() => {
      this.dirty = true;
      this.meetingTimer = MEETING_REFRESH_S;
    });

    this.app.ticker.add((ticker) => this.update(ticker.deltaMS / 1000));
    this.store.watch(['agents', 'floors', 'tick', 'lang', 'layouts'], () => {
      this.dirty = true;
    });
    this.store.watch(['selection'], () => this.focusSelected());
    this.store.watch(['lang'], () => {
      for (const scene of this.scenes.values()) scene.board.touch();
    });
  }

  setActive(active: boolean): void {
    if (active) {
      this.dirty = true;
      this.app.ticker.start();
    } else {
      this.app.ticker.stop();
    }
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.app.screen.height : 1;
    this.scrollY += (event.deltaY * unit) / SCALE;
    this.clampScroll();
  };

  private update(dt: number): void {
    this.elapsed += dt;
    const width = Math.max(MIN_WIDTH, Math.floor(this.app.screen.width / SCALE));
    if (width !== this.logicalWidth) {
      this.logicalWidth = width;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.sync();
    }
    this.darkTimer += dt;
    if (this.darkTimer >= DARK_CHECK_S) {
      this.darkTimer = 0;
      if (this.isDark() !== this.dark) this.dirty = true;
    }
    this.meetingTimer += dt;
    if (this.meetingTimer >= MEETING_REFRESH_S) {
      this.meetingTimer = 0;
      this.refreshMeetings();
    }
    this.liftLink.deliver(this.lift.tick(dt));
    this.garden.tick(dt, this.elapsed);
    this.backdrop.tick(this.elapsed);
    this.animate(dt);
    this.paintBoards();
    this.repath();
    this.cabin.update(this.lift, this.ground()?.layout.lift ?? null);
    this.drawLines();
    this.applyScroll();
  }

  private overrideOf(slug: string): FloorLayoutOverride | undefined {
    return resolveOverride(this.store.layouts, slug);
  }

  // The sky is night when the system theme is dark, or when the clock says so if the ambient life follows it.
  private isDark(): boolean {
    return daylightFor(ambient.get(), effectiveTheme(theme.get(), this.media.matches) === 'dark', new Date()) < 0.5;
  }

  private ground(): FloorScene | undefined {
    return this.sceneOrder[this.sceneOrder.length - 1];
  }

  private sync(): void {
    const floors = this.store.floorList();
    const agents = this.store.visibleAgents();
    for (const agent of agents) {
      if (!this.firstSeen.has(agent.key)) this.firstSeen.set(agent.key, this.seenCounter++);
    }
    const byFloor = new Map<string, AgentView[]>();
    for (const agent of this.store.officeAgents()) {
      const list = byFloor.get(agent.floor) ?? [];
      list.push(agent);
      byFloor.set(agent.floor, list);
    }

    const order = (key: string): number => this.firstSeen.get(key) ?? 0;
    const live = new Set<string>();
    const width = this.logicalWidth - SIDE_MARGIN * 2;
    this.sceneOrder = [];
    let top = SKY_H;
    for (const floor of floors) {
      const layout = computeFloorLayout(floor, byFloor.get(floor.slug) ?? [], width, order, this.overrideOf(floor.slug));
      let scene = this.scenes.get(floor.slug);
      if (scene) {
        scene.update(floor, layout, top);
      } else {
        scene = new FloorScene(this.actors, floor, layout, top, (tab) => this.hooks.openTab(tab));
        this.scenes.set(floor.slug, scene);
        this.backgrounds.addChild(scene.background);
        this.foregrounds.addChild(scene.foreground);
      }
      live.add(floor.slug);
      this.sceneOrder.push(scene);
      top += layout.height + FLOOR_GAP;
    }
    for (const [slug, scene] of this.scenes) {
      if (live.has(slug)) continue;
      scene.destroy();
      this.scenes.delete(slug);
    }
    const ground = this.ground();
    this.gardenTop = top;
    this.worldHeight = top + GARDEN_H;
    const dark = this.isDark();
    this.dark = dark;
    const backdropKey = [width, top, dark].join('|');
    if (backdropKey !== this.backdropKey) {
      this.backdropKey = backdropKey;
      this.backdrop.draw(width, top, dark);
    }
    this.garden.update(width, top, ground ? liftCenter(ground.layout) : width - 9, dark);
    this.lift.setStops(new Map(this.sceneOrder.map((scene) => [scene.slug, scene.top + scene.layout.walkY])), ground?.slug);

    this.syncEntries(agents);
    this.refreshMeetings();
    this.clampScroll();
  }

  private syncEntries(agents: readonly AgentView[]): void {
    const present = new Set<string>();
    for (const agent of agents) {
      const scene = this.scenes.get(agent.floor);
      if (!scene) continue;
      let entry = this.entries.get(agent.key);
      if (agent.away && (!entry || entry.view.faded)) continue;
      present.add(agent.key);
      if (!agent.away && this.garden.lot.bayOf(agent.key) !== null) this.garden.lot.release(agent.key);
      const saturation = scene.view.kind === 'observed' ? 0.4 : 1;
      const outfit = paletteRole(agent.roleKind, this.overrideOf(agent.floor));
      const look = `${outfit}|${saturation}`;
      if (entry && entry.look !== look) {
        const position = entry.view.position;
        this.liftLink.cancel(agent.key);
        entry.view.destroy();
        entry.view = this.createView(agent, saturation, outfit);
        entry.view.placeAt(position);
        entry.look = look;
      } else if (!entry) {
        const view = this.createView(agent, saturation, outfit);
        if (this.primed && this.ground()) view.placeAt(this.garden.gate());
        entry = { view, agent, scale: 1, look, ownDesk: null, desk: null, slot: null, goalScene: null };
        this.entries.set(agent.key, entry);
      }
      entry.agent = agent;

      const slot = scene.layout.desks.get(agent.key) ?? null;
      entry.slot = slot;
      if (slot) entry.scale = slot.scale;
      if (slot?.lead) {
        this.releaseDesk(entry);
        entry.desk = scene.leadDeskParts;
      } else if (slot) {
        if (!entry.ownDesk) {
          entry.ownDesk = buildDesk(SLOT_W, false);
          this.actors.addChild(entry.ownDesk.back, entry.ownDesk.front);
        }
        scene.placeDesk(entry.ownDesk, slot);
        entry.desk = entry.ownDesk;
      } else {
        this.releaseDesk(entry);
        entry.desk = null;
      }
    }

    this.primed = agents.length > 0;
    for (const [key, entry] of this.entries) {
      if (!entry.view.gone && (present.has(key) || entry.view.leaving)) continue;
      this.releaseDesk(entry);
      this.garden.lot.release(key);
      this.liftLink.cancel(key);
      entry.view.destroy();
      this.entries.delete(key);
    }
  }

  private createView(agent: AgentView, saturation: number, outfit: AgentView['roleKind']): CharacterView {
    const look = { roleKind: outfit, seed: hashString(agent.key), saturation };
    const view = new CharacterView(agent.key, look, (key) => this.store.select(key));
    this.actors.addChild(view.root);
    return view;
  }

  private releaseDesk(entry: Entry): void {
    if (!entry.ownDesk) return;
    entry.ownDesk.back.destroy();
    entry.ownDesk.front.destroy({ children: true });
    entry.ownDesk = null;
  }

  private refreshMeetings(): void {
    this.meetings = this.computeMeetings();
    this.coffee = this.planCoffee();
    this.assignTargets();
  }

  // Only agents still shown idle, at their desk and not in a meeting go for coffee; anything else sends them back.
  private planCoffee(): Map<string, CoffeeVisit> {
    const visits = new Map<string, CoffeeVisit>();
    if (!ambient.get().coffee) return visits;
    const candidates: AgentView[] = [];
    for (const [key, entry] of this.entries) {
      const agent = this.store.agents.get(key) ?? entry.agent;
      if (entry.slot === null || this.meetings.has(key) || this.store.shownState(agent) !== 'idle') continue;
      if (this.scenes.get(agent.floor)?.view.kind === 'observed') continue;
      candidates.push(agent);
    }
    for (const visit of coffeePlan(candidates, this.store.now())) visits.set(visit.key, visit);
    return visits;
  }

  private canMeet(agent: AgentView): boolean {
    if (agent.endedAt !== null || agent.away || !this.entries.has(agent.key)) return false;
    const state = this.store.shownState(agent);
    return state !== 'done' && state !== 'failed' && state !== 'testing';
  }

  private hostFloor(a: AgentView, b: AgentView): string {
    if (a.floor === b.floor) return a.floor;
    if (this.scenes.get(a.floor)?.view.kind === 'direccion') return b.floor;
    if (this.scenes.get(b.floor)?.view.kind === 'direccion') return a.floor;
    return a.key < b.key ? a.floor : b.floor;
  }

  private computeMeetings(): Map<string, MeetingSeat> {
    const seats = new Map<string, MeetingSeat>();
    const usedPerFloor = new Map<string, number>();
    for (const pair of findMeetingPairs(this.store.messages, this.store.now())) {
      const a = this.store.agents.get(pair.a);
      const b = this.store.agents.get(pair.b);
      if (!a || !b || !this.canMeet(a) || !this.canMeet(b)) continue;
      if (seats.has(a.key) || seats.has(b.key)) continue;
      const floor = this.hostFloor(a, b);
      const scene = this.scenes.get(floor);
      if (!scene) continue;
      const used = usedPerFloor.get(floor) ?? 0;
      usedPerFloor.set(floor, used + 1);
      const count = scene.layout.seats.length;
      seats.set(a.key, { floor, seat: (used * 2) % count });
      seats.set(b.key, { floor, seat: (used * 2 + 1) % count });
    }
    return seats;
  }

  private assignTargets(): void {
    const labUse = new Map<string, number>();
    for (const [key, entry] of this.entries) {
      const agent = this.store.agents.get(key) ?? entry.agent;
      const scene = this.scenes.get(agent.floor);
      if (!scene) continue;
      const resolved = this.resolveTarget(agent, entry, scene, labUse);
      if (!resolved) continue;
      entry.goalScene = resolved.scene;
      entry.view.setTarget(resolved.target, this.buildPath(entry.view.position, resolved.target, resolved.scene), this.liftLink);
    }
  }

  private repath(): void {
    for (const entry of this.entries.values()) {
      if (!entry.view.needsPath) continue;
      const target = entry.view.target;
      const scene = entry.goalScene && this.scenes.get(entry.goalScene.slug) === entry.goalScene ? entry.goalScene : this.sceneAt(target?.y ?? 0);
      entry.view.setPath(target && scene ? this.buildPath(entry.view.position, target, scene) : []);
    }
  }

  private resolveTarget(
    agent: AgentView,
    entry: Entry,
    scene: FloorScene,
    labUse: Map<string, number>,
  ): { target: Target; scene: FloorScene } | null {
    const state = this.store.shownState(agent);
    if (agent.away) {
      const ground = this.ground();
      if (!ground) return null;
      if (entry.view.waving(state)) return null;
      const spot = this.garden.spot(this.garden.lot.reserve(agent.key));
      return { scene: ground, target: { id: 'exit', kind: 'exit', x: spot.x, y: spot.y, z: spot.y + 1, desk: null } };
    }
    const leaving = state === 'done' || state === 'failed' || agent.endedAt !== null;

    if (!leaving && state === 'testing') {
      const index = labUse.get(scene.slug) ?? 0;
      labUse.set(scene.slug, index + 1);
      const stands = scene.layout.labStands;
      const world = scene.toWorld(stands[index % stands.length]);
      const x = world.x + Math.floor(index / stands.length) * 4;
      return { scene, target: { id: `lab:${scene.slug}:${index}`, kind: 'lab', x, y: world.y, z: world.y, desk: entry.desk } };
    }

    const meeting = leaving ? undefined : this.meetings.get(agent.key);
    const host = meeting ? this.scenes.get(meeting.floor) : undefined;
    if (meeting && host) {
      const seat = host.layout.seats[meeting.seat];
      const world = host.toWorld(seat);
      const z = seat.behind ? host.tableBaseZ - 1 : world.y;
      return {
        scene: host,
        target: { id: `meet:${host.slug}:${meeting.seat}`, kind: 'meeting', x: world.x, y: world.y, z, desk: entry.desk },
      };
    }

    const coffee = leaving || state !== 'idle' ? undefined : this.coffee.get(agent.key);
    if (coffee) {
      const stands = scene.layout.coffeeStands;
      const world = scene.toWorld(stands[coffee.seat % stands.length]);
      return { scene, target: { id: `coffee:${scene.slug}:${coffee.seat}`, kind: 'coffee', x: world.x, y: world.y, z: world.y, desk: entry.desk } };
    }

    const slot = entry.slot;
    if (!slot || !entry.desk) return null;
    const seatX = slot.lead ? LEAD_SEAT_X : DESK_SEAT_X;
    return {
      scene,
      target: {
        id: `desk:${scene.slug}:${agent.key}`,
        kind: 'desk',
        x: slot.x + seatX * slot.scale,
        y: scene.top + slot.y + DESK_FEET_Y * slot.scale,
        z: scene.deskBaseZ(slot) - 1,
        desk: entry.desk,
      },
    };
  }

  private sceneAt(y: number): FloorScene | undefined {
    for (const scene of this.sceneOrder) {
      if (y >= scene.top && y < scene.top + scene.layout.height + FLOOR_GAP) return scene;
    }
    return this.sceneOrder[this.sceneOrder.length - 1];
  }

  private buildPath(from: Point, target: Target, targetScene: FloorScene): Point[] {
    const goal = { x: target.x, y: target.y };
    const gate = (scene: FloorScene): Point => liftGate(scene.layout, scene.top, scene.slug);
    const ground = this.ground();
    const pathY = this.garden.pathY;
    if (ground && from.y >= this.gardenTop) {
      if (target.kind === 'exit') return [{ x: from.x, y: pathY }, { x: goal.x, y: pathY }, goal];
      const door = gardenDoor(ground.layout, ground.top);
      return [...gardenArrival(from, door, pathY, gate(ground)), ...liftRoute(gate(ground), gate(targetScene), goal).slice(1)];
    }
    const origin = this.sceneAt(from.y);
    if (target.kind === 'exit') {
      const door = gardenDoor(targetScene.layout, targetScene.top);
      const outside = gardenRoute(gate(targetScene), door, pathY, goal).slice(1);
      return liftRoute(origin ? gate(origin) : null, gate(targetScene), ...outside);
    }
    if (!origin || origin === targetScene) return [goal];
    return [gate(origin), gate(targetScene), goal];
  }

  private animate(dt: number): void {
    const now = this.store.now();
    const asking = new Set(this.store.questions.map((question) => question.agentKey));
    const testingFloors = new Set<string>();
    const chatting = this.coffeeChats();
    for (const [key, entry] of this.entries) {
      const agent = this.store.agents.get(key) ?? entry.agent;
      const state = this.store.shownState(agent);
      if (state === 'testing') testingFloors.add(agent.floor);
      if (agent.away && entry.view.leaving && !entry.view.moving) this.garden.lot.depart(key);
      entry.view.update({
        dt,
        now,
        state,
        scale: entry.scale,
        selected: key === this.store.selectedKey,
        asking: asking.has(key),
        ended: agent.endedAt !== null && !agent.away,
        away: agent.away,
        hold: agent.away && this.garden.lot.boarding(key),
        lastTest: agent.lastTest,
        context: contextOf(agent)?.usedPct ?? null,
        chat: chatting.has(key),
      });
    }
    for (const scene of this.sceneOrder) scene.tick(this.elapsed, testingFloors.has(scene.slug));
  }

  // Two people who have both reached the coffee machine of a floor talk.
  private coffeeChats(): Set<string> {
    const settled = new Map<string, string[]>();
    for (const [key, entry] of this.entries) {
      const goal = entry.view.target;
      if (goal?.kind !== 'coffee' || entry.view.moving) continue;
      const floor = entry.goalScene?.slug ?? entry.agent.floor;
      const list = settled.get(floor) ?? [];
      list.push(key);
      settled.set(floor, list);
    }
    const chatting = new Set<string>();
    for (const keys of settled.values()) {
      if (keys.length >= 2) for (const key of keys) chatting.add(key);
    }
    return chatting;
  }

  // At most one whiteboard is repainted per frame, and only one on screen whose text changed.
  private paintBoards(): void {
    const top = this.scrollY;
    const bottom = top + this.app.screen.height / SCALE;
    for (const scene of this.sceneOrder) {
      if (scene.top + WALL_H < top || scene.top > bottom || !scene.board.due(this.elapsed)) continue;
      const input = boardInputFor(this.store, scene.slug, this.hooks.usageToday());
      if (input && scene.board.refresh(this.elapsed, boardData(input), accentCss(scene.view))) return;
    }
  }

  private latestRecipient(fromKey: string): string | null {
    const { messages } = this.store;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].fromKey === fromKey) return messages[index].toKey;
    }
    return null;
  }

  private headPoint(entry: Entry): Point {
    const { x, y } = entry.view.position;
    return { x, y: y - HEAD_HEIGHT * (entry.slot?.scale ?? 1) };
  }

  private drawLines(): void {
    const g = this.lines;
    g.clear();
    for (const [key, entry] of this.entries) {
      if (!entry.view.talkingActive) continue;
      const recipient = this.latestRecipient(key);
      const other = recipient === null ? undefined : this.entries.get(recipient);
      if (!other) continue;
      dashedLine(g, this.headPoint(entry), this.headPoint(other), this.elapsed, TALK_LINE_COLOR);
    }
  }

  private maxScroll(): number {
    return Math.max(0, this.worldHeight - this.app.screen.height / SCALE);
  }

  private clampScroll(): void {
    this.scrollY = Math.min(Math.max(0, this.scrollY), this.maxScroll());
  }

  private applyScroll(): void {
    this.clampScroll();
    this.world.position.set(SIDE_MARGIN * SCALE, -Math.round(this.scrollY) * SCALE);
    const g = this.scrollbar;
    g.clear();
    const max = this.maxScroll();
    if (max <= 0) return;
    const { width, height } = this.app.screen;
    const track = height - 8;
    const thumb = Math.max(24, (track * (height / SCALE)) / this.worldHeight);
    const thumbY = 4 + (track - thumb) * (this.scrollY / max);
    g.rect(width - 8, 4, 4, track).fill({ color: 0xffffff, alpha: 0.08 });
    g.rect(width - 8, thumbY, 4, thumb).fill({ color: 0xffffff, alpha: 0.35 });
  }

  focusAgent(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.scrollY = entry.view.position.y - this.app.screen.height / SCALE / 2;
    this.clampScroll();
  }

  focusFloor(slug: string): void {
    const scene = this.scenes.get(slug);
    if (!scene) return;
    this.scrollY = scene.top - FLOOR_GAP;
    this.clampScroll();
  }

  private focusSelected(): void {
    const key = this.store.selectedKey;
    const entry = key === null ? undefined : this.entries.get(key);
    if (!entry) return;
    const { y } = entry.view.position;
    const viewport = this.app.screen.height / SCALE;
    if (y - 30 < this.scrollY || y + 12 > this.scrollY + viewport) {
      this.scrollY = y - viewport / 2;
      this.clampScroll();
    }
  }
}

export async function mountOffice(host: HTMLElement, store: Store, hooks: OfficeHooks): Promise<OfficeHandle> {
  const office = new OfficeView(store, hooks);
  await office.mount(host);
  return {
    setActive: (active) => office.setActive(active),
    focusAgent: (key) => office.focusAgent(key),
    focusFloor: (slug) => office.focusFloor(slug),
  };
}
