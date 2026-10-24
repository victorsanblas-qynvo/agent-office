import { Rectangle, type Container } from 'pixi.js';
import type { LiftService } from '../lift';
import { motionReduced } from '../motion';
import { buildCharacter, type CharacterParts, type Look } from '../sprites/sprites';
import type { AgentState, TestResult } from '../types';
import {
  BADGE_VISIBLE_S,
  CHAR_H,
  CHAR_W,
  EXIT_FADE_S,
  FADE_HOLD_S,
  FADE_S,
  TALK_VISIBLE_S,
  WALK_SPEED,
} from './constants';
import { Overlay, type BadgeKind, type IconKind } from './effects';
import type { DeskParts } from './furniture';
import { liftLeg, type LiftLeg, type Point } from './layout';

export type TargetKind = 'desk' | 'lab' | 'meeting' | 'coffee' | 'exit';

export type Target = {
  id: string;
  kind: TargetKind;
  x: number;
  y: number;
  z: number;
  desk: DeskParts | null;
};

export type FrameInput = {
  dt: number;
  now: number;
  state: AgentState;
  scale: number;
  selected: boolean;
  asking: boolean;
  ended: boolean;
  away: boolean;
  hold: boolean;
  lastTest: TestResult | null;
  context: number | null;
  // At the coffee machine with someone else: the mouths move, without a conversation line.
  chat?: boolean;
};

type Ride = { leg: LiftLeg; phase: 'approach' | 'waiting' | 'boarding' | 'riding' };

const FADING: ReadonlySet<AgentState> = new Set<AgentState>(['done', 'failed']);

export class CharacterView {
  readonly root: Container;

  private readonly parts: CharacterParts;
  private readonly overlay = new Overlay();
  private goal: Target | null = null;
  private path: Point[] = [];
  private x = 0;
  private y = 0;
  private seconds = 0;
  private walkClock = 0;
  private lastState: AgentState | null = null;
  private stateStart = 0;
  private fadeStart: number | null = null;
  private seenTestTs: number | null | undefined = undefined;
  private badge: BadgeKind | null = null;
  private badgeUntil = 0;
  private interactive = true;
  private placed = false;
  private exitAt: number | null = null;
  private left = false;
  private shown = 1;
  private lift: LiftService<Point> | null = null;
  private ride: Ride | null = null;
  private replanAfterRide = false;
  private pathWanted = false;
  private walking = false;
  private chatting = false;

  constructor(
    readonly key: string,
    look: Look,
    onSelect: (key: string) => void,
  ) {
    this.parts = buildCharacter(look);
    this.root = this.parts.root;
    this.root.addChild(this.overlay.root);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.interactiveChildren = false;
    this.root.hitArea = new Rectangle(0, 0, CHAR_W, CHAR_H);
    this.root.on('pointertap', () => onSelect(key));
  }

  get position(): Point {
    return { x: this.x, y: this.y };
  }

  get target(): Target | null {
    return this.goal;
  }

  get moving(): boolean {
    return this.path.length > 0 || this.ride !== null || this.pathWanted;
  }

  get needsPath(): boolean {
    return this.pathWanted;
  }

  get leaving(): boolean {
    return this.goal?.kind === 'exit';
  }

  get gone(): boolean {
    return this.left;
  }

  get faded(): boolean {
    return !this.leaving && this.shown <= 0;
  }

  waving(state: AgentState): boolean {
    if (state !== 'done' || this.leaving) return false;
    return this.lastState !== 'done' || this.seconds - this.stateStart < FADE_HOLD_S;
  }

  placeAt(point: Point): void {
    this.cancelRide();
    this.x = point.x;
    this.y = point.y;
    this.path = [];
    this.pathWanted = false;
    this.placed = true;
  }

  snapToTarget(): void {
    this.cancelRide();
    if (this.goal) this.placeAt({ x: this.goal.x, y: this.goal.y });
  }

  setPath(path: Point[]): void {
    this.path = path;
    this.pathWanted = false;
  }

  get talkingActive(): boolean {
    return this.lastState === 'talking' && this.seconds - this.stateStart < TALK_VISIBLE_S;
  }

  setTarget(target: Target, path: Point[], lift: LiftService<Point> | null): void {
    this.lift = lift;
    const previous = this.goal;
    this.goal = target;
    if (this.ride && (this.ride.phase === 'boarding' || this.ride.phase === 'riding')) {
      if (!previous || previous.id !== target.id || previous.x !== target.x || previous.y !== target.y) this.replanAfterRide = true;
      return;
    }
    if (this.ride && previous && previous.id !== target.id) this.cancelRide();
    if (!previous && this.placed) {
      this.path = path;
      return;
    }
    if (!previous) {
      this.x = target.x;
      this.y = target.y;
      this.path = [];
      return;
    }
    if (previous.id !== target.id) {
      this.path = path;
      return;
    }
    if (previous.x === target.x && previous.y === target.y) return;
    if (this.path.length > 0) {
      this.path[this.path.length - 1] = { x: target.x, y: target.y };
    } else {
      this.x = target.x;
      this.y = target.y;
    }
  }

  update(input: FrameInput): void {
    this.seconds += input.dt;
    const t = this.seconds;
    this.advance(input.dt);
    this.trackState(input.state);
    this.trackTest(input);
    this.resetPose();
    this.chatting = input.chat === true && this.goal?.kind === 'coffee';

    if (this.walking) this.poseWalking();
    else if (!this.moving) this.poseFor(input.state, t);

    this.overlay.setIcon(this.iconFor(input.state), t);
    this.overlay.setProgress(input.state === 'testing', t);
    this.overlay.setSelected(input.selected);
    this.overlay.setAsking(input.asking, t);
    this.overlay.setContext(input.context);
    this.overlay.setBadge(this.badgeUntil > t ? this.badge : null);

    this.applyDeskGlow(input.state, t);
    this.applyTransform(input);
  }

  destroy(): void {
    this.cancelRide();
    this.root.destroy({ children: true });
  }

  private cancelRide(): void {
    if (this.ride) this.lift?.cancel(this.key);
    this.ride = null;
    this.replanAfterRide = false;
  }

  private walkTo(point: Point, budget: number): number {
    const dx = point.x - this.x;
    const dy = point.y - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0) this.walking = true;
    if (distance <= budget) {
      this.x = point.x;
      this.y = point.y;
      return budget - distance;
    }
    this.x += (dx / distance) * budget;
    this.y += (dy / distance) * budget;
    return -1;
  }

  private advance(dt: number): void {
    const reduced = motionReduced();
    let budget = reduced ? Infinity : WALK_SPEED * dt;
    this.walking = false;
    const lift = this.lift;
    for (let guard = 0; guard < 16; guard += 1) {
      if (!this.ride && lift && this.path.length > 1) {
        const leg = liftLeg(this.path, (from, to) => lift.serves(from, to));
        if (leg) this.ride = { leg, phase: 'approach' };
      }
      const ride = this.ride;
      if (ride && lift) {
        const { leg } = ride;
        if (ride.phase === 'approach' || ride.phase === 'boarding') {
          const point = ride.phase === 'approach' ? lift.landing(leg.from, leg.fromFace) : lift.cabin(leg.from);
          budget = this.walkTo(point, Math.max(0, budget));
          if (budget < 0) break;
          if (ride.phase === 'approach') {
            lift.request({ key: this.key, from: leg.from, to: leg.to, fromFace: leg.fromFace, toFace: leg.toFace });
            ride.phase = 'waiting';
          } else {
            lift.aboard(this.key);
            ride.phase = 'riding';
          }
          continue;
        }
        if (ride.phase === 'riding') this.y = lift.position();
        const event = lift.take(this.key);
        if (!event) break;
        if (event.type === 'cancelled') {
          this.snapToTarget();
          break;
        }
        if (event.type === 'boarded' && ride.phase === 'waiting') {
          ride.phase = 'boarding';
        } else if (event.type === 'arrived' && ride.phase === 'riding') {
          const exit = lift.cabin(leg.to);
          this.x = exit.x;
          this.y = exit.y;
          this.path.splice(0, 2);
          this.ride = null;
          if (this.replanAfterRide) {
            this.replanAfterRide = false;
            this.path = [];
            this.pathWanted = true;
            break;
          }
        }
        continue;
      }
      if (budget <= 0 || this.path.length === 0) break;
      budget = this.walkTo(this.path[0], budget);
      if (budget < 0) break;
      this.path.shift();
    }
    if (reduced) this.walking = false;
    if (this.walking) this.walkClock += dt;
  }

  private trackState(state: AgentState): void {
    if (state === this.lastState) return;
    this.lastState = state;
    this.stateStart = this.seconds;
    this.fadeStart = FADING.has(state) ? this.seconds : null;
  }

  private trackTest(input: FrameInput): void {
    const ts = input.lastTest?.ts ?? null;
    if (this.seenTestTs === undefined) {
      this.seenTestTs = ts;
      if (input.lastTest && input.now - input.lastTest.ts < BADGE_VISIBLE_S * 1000) this.showBadge(input.lastTest.ok);
      return;
    }
    if (ts === this.seenTestTs) return;
    this.seenTestTs = ts;
    if (input.lastTest) this.showBadge(input.lastTest.ok);
  }

  private showBadge(ok: boolean): void {
    this.badge = ok ? 'ok' : 'fail';
    this.badgeUntil = this.seconds + BADGE_VISIBLE_S;
  }

  private resetPose(): void {
    const p = this.parts;
    p.rig.position.set(0, 0);
    p.head.position.set(0, 0);
    p.legL.position.set(5, 18);
    p.legR.position.set(8, 18);
    p.armL.rotation = 0;
    p.armR.rotation = 0;
    p.cup.visible = false;
    p.folder.visible = false;
    p.flask.visible = false;
    p.stamp.visible = false;
    p.glow.visible = false;
    p.tint.visible = false;
    p.mouth.scale.y = 1;
  }

  private poseWalking(): void {
    const p = this.parts;
    const swing = Math.sin(this.walkClock * 12);
    const stepLeft = Math.floor(this.walkClock * 6) % 2 === 0;
    p.legL.y = stepLeft ? 17 : 18;
    p.legR.y = stepLeft ? 18 : 17;
    p.rig.y = stepLeft ? -1 : 0;
    p.armL.rotation = swing * 0.6;
    p.armR.rotation = -swing * 0.6;
  }

  private poseFor(state: AgentState, t: number): void {
    switch (state) {
      case 'idle':
        return this.poseIdle(t);
      case 'working':
        return this.poseWorking(t);
      case 'reading':
        return this.poseReading(t);
      case 'testing':
        return this.poseTesting(t);
      case 'checking':
        return this.poseChecking(t);
      case 'asking':
        return this.poseAsking(t);
      case 'talking':
        return this.poseTalking(t);
      case 'blocked':
        return this.poseBlocked();
      case 'failed':
        this.parts.head.y = 1;
        return;
      case 'done':
        return;
    }
  }

  private poseIdle(t: number): void {
    const p = this.parts;
    p.rig.y = Math.round(Math.sin(t * 2.2) * 0.5 + 0.5);
    const sipping = t % 6 > 5.2;
    p.armR.rotation = sipping ? 1.55 : 1.0;
    p.cup.visible = true;
    p.cup.rotation = -p.armR.rotation;
    p.steam.alpha = 0.5 + 0.5 * Math.sin(t * 3);
    p.steam.y = -Math.floor((t * 2) % 2);
    if (this.chatting) p.mouth.scale.y = Math.floor(t * 6) % 3 === 0 ? 2 : 1;
  }

  private poseWorking(t: number): void {
    const p = this.parts;
    const beat = Math.floor(t * 9) % 2 === 0;
    p.armL.rotation = -0.55 + (beat ? 0.14 : -0.1);
    p.armR.rotation = 0.55 + (beat ? -0.1 : 0.14);
    p.head.y = Math.floor(t * 1.5) % 4 === 0 ? 1 : 0;
    p.glow.visible = true;
    p.glow.alpha = 0.6 + 0.4 * Math.sin(t * 5);
  }

  private poseReading(t: number): void {
    const p = this.parts;
    p.armL.rotation = -0.95;
    p.armR.rotation = 0.95;
    p.head.y = 1;
    p.folder.visible = true;
    const cycle = (t % 1.6) / 1.6;
    p.page.scale.x = cycle < 0.35 ? Math.cos((cycle / 0.35) * Math.PI) : 1;
  }

  private poseTesting(t: number): void {
    const p = this.parts;
    p.armL.rotation = -2.1 + Math.sin(t * 4) * 0.12;
    p.armR.rotation = 0.8 + Math.sin(t * 7) * 0.45;
    p.flask.visible = true;
    p.flask.rotation = -p.armL.rotation;
  }

  private poseChecking(t: number): void {
    const p = this.parts;
    p.armL.rotation = -0.5;
    p.armR.rotation = Math.floor(t * 1.8) % 2 === 0 ? 2.6 : 2.1;
    p.stamp.visible = true;
  }

  private poseAsking(t: number): void {
    this.parts.armR.rotation = Math.PI + 0.25 + Math.sin(t * 6) * 0.12;
  }

  private poseTalking(t: number): void {
    const p = this.parts;
    p.mouth.scale.y = Math.floor(t * 8) % 2 === 0 ? 2 : 1;
    p.armL.rotation = -0.9 + Math.sin(t * 6) * 0.45;
  }

  private poseBlocked(): void {
    const p = this.parts;
    p.armL.rotation = -1.2;
    p.armR.rotation = 1.2;
    p.head.y = 1;
    p.tint.visible = true;
  }

  private iconFor(state: AgentState): IconKind | null {
    switch (state) {
      case 'asking':
        return 'ask';
      case 'talking':
        return this.talkingActive ? 'talk' : null;
      case 'blocked':
        return 'lock';
      case 'checking':
        return 'stamp';
      case 'done':
        return 'check';
      case 'failed':
        return 'cross';
      default:
        return null;
    }
  }

  private applyDeskGlow(state: AgentState, t: number): void {
    const desk = this.goal?.desk ?? null;
    if (!desk) return;
    const lit = !this.moving && this.goal?.kind === 'desk' && state === 'working';
    desk.glow.visible = lit;
    if (lit) desk.glow.alpha = 0.6 + 0.4 * Math.sin(t * 5);
  }

  private exitAlpha(): number {
    if (this.moving) {
      this.exitAt = null;
      return 1;
    }
    if (this.exitAt === null) this.exitAt = this.seconds;
    const alpha = Math.max(0, 1 - (this.seconds - this.exitAt) / EXIT_FADE_S);
    if (alpha <= 0) this.left = true;
    return alpha;
  }

  private applyTransform(input: FrameInput): void {
    let alpha = 1;
    if (this.leaving && input.hold) {
      this.exitAt = null;
    } else if (this.leaving) {
      alpha = this.exitAlpha();
    } else {
      this.exitAt = null;
      if (this.fadeStart !== null && !input.away) {
        alpha = Math.max(0, 1 - (this.seconds - this.fadeStart - FADE_HOLD_S) / FADE_S);
        alpha = Math.min(1, alpha);
      }
      if (input.ended) alpha = Math.min(alpha, 0.45);
    }

    this.shown = alpha;
    const visible = alpha > 0.01;
    this.root.visible = visible;
    this.root.alpha = alpha;
    if (visible !== this.interactive) {
      this.interactive = visible;
      this.root.eventMode = visible ? 'static' : 'none';
    }

    this.root.position.set(Math.round(this.x), Math.round(this.y));
    this.root.scale.set(input.scale);
    const settled = !this.moving && this.goal !== null;
    this.root.zIndex = settled && this.goal ? this.goal.z : this.y;
  }
}
