import { Color, Group, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector3, type Material } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { LiftService } from '../lift';
import { modelOverride } from '../layouts';
import { motionReduced } from '../motion';
import type { AgentState, FloorLayoutOverride, RoleKind, TestResult } from '../types';
import { buildMannequin, type AssetLibrary, type LoadedModel, type LogicalClip } from './assets';
import {
  AISLE_Z,
  BADGE_VISIBLE_S,
  DONE_HOLD_S,
  ENDED_ALPHA,
  EXIT_FADE_S,
  FADE_S,
  FAILED_HOLD_S,
  LABEL_FAR,
  LABEL_NEAR,
  LIFT_SPEED,
  LIFT_W,
  SPAWN_FADE_S,
  STEP_DOWN,
  TALK_VISIBLE_S,
  TURN_SPEED,
  WALK_SPEED,
} from './constants';
import { buildProps, coffeeLevel, type Props } from './effects';
import type { Desk } from './furniture';
import { AgentLabel, type BadgeKind, type LabelIcon, type LabelLod } from './labels';
import { liftLeg, planPath, STREET, type LiftLeg, type LiftStops, type Nav, type Target, type Waypoint } from './layout';
import { hashString, mute } from './materials';
import { createProxy, createRings, type Rings } from './picking';
import { findBones, GltfRig, MannequinRig, type Rig } from './rig';

export type CharacterLook = { roleKind: RoleKind; muted: boolean; override?: FloorLayoutOverride };

export type FrameInput = {
  dt: number;
  now: number;
  state: AgentState;
  scale: number;
  selected: boolean;
  pending: boolean;
  ended: boolean;
  away: boolean;
  hold: boolean;
  lastTest: TestResult | null;
  name: string;
  following: boolean;
  camera: Vector3;
  context: number | null;
  // At the coffee machine with someone else: they look at each other and talk, without a conversation line.
  chat?: boolean;
};

export type Resolver = (floor: string) => Vector3 | null;

export type Occlusion = (point: Vector3) => boolean;

export type SceneLift = LiftService<{ x: number; z: number }> & { stops(): LiftStops };

type Ride = { leg: LiftLeg; phase: 'approach' | 'waiting' | 'boarding' | 'riding' };

// Seconds of walking granted per frame when motion is reduced: enough to reach any destination at once.
const TELEPORT_S = 1e4;
const STEP_REACH = LIFT_W / 2 + 0.3;

type Activity = {
  clip: LogicalClip;
  once: boolean;
  typing: number;
  mug: number;
  sip: number;
  folder: number;
  gesture: number;
  slump: number;
  stamp: boolean;
  headPitch: number;
  headYaw: number;
  tint: boolean;
};

const BASE: Activity = {
  clip: 'idle',
  once: false,
  typing: 0,
  mug: 0,
  sip: 0,
  folder: 0,
  gesture: 0,
  slump: 0,
  stamp: false,
  headPitch: 0,
  headYaw: 0,
  tint: false,
};

const UP = new Vector3(0, 1, 0);
const LABEL_HEIGHT = 1.95;
const HEAD_HEIGHT = 1.62;
const WAIST_HEIGHT = 0.9;

const ROLE_SHIRTS: Partial<Record<RoleKind, number>> = {
  director: 0x24324d,
  lead: 0xb33f3f,
  tester: 0xe07b24,
  reviewer: 0x30404f,
  writer: 0x1f8a70,
  planReviewer: 0x3b4f7a,
  skillwright: 0x8e5a2b,
  skillReviewer: 0x4f6a2f,
  intern: 0xa3adb5,
};

const _a = new Vector3();
const _b = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _hand = new Vector3();
const _handL = new Vector3();
const _handR = new Vector3();

function wrapAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class Character {
  readonly root = new Group();
  readonly proxy: Mesh;
  readonly label: AgentLabel;
  desk: Desk | null = null;
  target: Target | null = null;
  pickable = false;
  private body: Group | null = null;
  private rig: Rig | null = null;
  private materials: MeshStandardMaterial[] = [];
  private meshes: Mesh[] = [];
  private readonly props: Props;
  private readonly rings: Rings;
  private at: Waypoint = { floor: '', x: 0, z: 0, lane: null };
  private path: Waypoint[] = [];
  private transfer: { progress: number; vertical: boolean; bridge: boolean } | null = null;
  private pendingReplan = false;
  private lift: SceneLift | null = null;
  private ride: Ride | null = null;
  private viaBridge = false;
  private placed = false;
  private nav: Nav | null = null;
  private heading = 0;
  private desiredHeading = 0;
  private seconds = 0;
  private lastState: AgentState | null = null;
  private stateStart = 0;
  private seenTestTs: number | null | undefined = undefined;
  private badge: BadgeKind | null = null;
  private badgeUntil = 0;
  private readyAt: number | null = null;
  private lookKey = '';
  private loadToken = 0;
  private disposed = false;
  private alphaLevel = -1;
  private exitAt: number | null = null;
  private left = false;
  private shown = 1;
  private tintLevel = -1;
  private castShadows = true;
  private readonly weights = { typing: 0, mug: 0, sip: 0, folder: 0, gesture: 0, slump: 0, pitch: 0, yaw: 0 };

  constructor(
    readonly key: string,
    private readonly assets: AssetLibrary,
    onSelect: (key: string) => void,
    onFollow: (key: string) => void,
  ) {
    this.proxy = createProxy(key);
    this.rings = createRings();
    this.props = buildProps();
    this.label = new AgentLabel(key, onSelect, onFollow);
    this.label.object.position.y = LABEL_HEIGHT;
    this.root.add(this.proxy, this.rings.select, this.rings.ask, this.props.mug, this.props.folder, this.props.stamp, this.props.pad, this.label.object);
  }

  get moving(): boolean {
    return this.path.length > 0 || this.transfer !== null || this.ride !== null;
  }

  get floor(): string {
    return this.at.floor;
  }

  get talkingActive(): boolean {
    return this.lastState === 'talking' && this.seconds - this.stateStart < TALK_VISIBLE_S;
  }

  get ready(): boolean {
    return this.rig !== null;
  }

  get leaving(): boolean {
    return this.target?.kind === 'exit';
  }

  get gone(): boolean {
    return this.left;
  }

  get faded(): boolean {
    return !this.leaving && this.shown <= 0;
  }

  waving(state: AgentState): boolean {
    if (state !== 'done' || this.leaving) return false;
    return this.lastState !== 'done' || this.seconds - this.stateStart < DONE_HOLD_S;
  }

  placeAt(point: Waypoint, nav: Nav): void {
    this.nav = nav;
    this.cancelRide();
    this.at = { ...point };
    this.path = [];
    this.transfer = null;
    this.pendingReplan = false;
    this.placed = true;
  }

  headPoint(target: Vector3): Vector3 {
    return target.copy(this.root.position).addScaledVector(UP, HEAD_HEIGHT * this.root.scale.y);
  }

  setLook(look: CharacterLook): void {
    const key = `${look.roleKind}|${look.muted ? 1 : 0}|${modelOverride(look.override, look.roleKind) ?? ''}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    const token = ++this.loadToken;
    void this.assets.modelFor(look.roleKind, look.override).then((model) => {
      if (this.disposed || token !== this.loadToken) return;
      try {
        this.attach(model, look);
      } catch (error) {
        console.warn(`Agent Office: personaje de respaldo para ${this.key}`, error);
        this.attach(null, look);
      }
    });
  }

  setTarget(target: Target, nav: Nav, lift: SceneLift | null): void {
    this.nav = nav;
    this.lift = lift;
    const previous = this.target;
    this.target = target;
    if (!this.placed || !nav.floors.has(this.at.floor)) {
      this.snapToTarget();
      this.placed = true;
      return;
    }
    if (previous && previous.id === target.id) {
      const same = previous.floor === target.floor && Math.abs(previous.x - target.x) < 1e-3 && Math.abs(previous.z - target.z) < 1e-3;
      if (same) return;
      if (!this.moving) {
        this.snapToTarget();
        return;
      }
    }
    this.replan();
  }

  update(input: FrameInput, resolve: Resolver, occluded: Occlusion): void {
    this.seconds += input.dt;
    const t = this.seconds;
    this.trackState(input.state);
    this.trackTest(input);
    this.advance(input.dt, resolve);

    const position = this.worldPosition(resolve, _a);
    if (!position) {
      if (this.target) this.snapToTarget();
      this.root.visible = false;
      this.pickable = false;
      return;
    }
    this.root.visible = true;
    this.root.position.copy(position);
    if (!this.moving && this.target) this.desiredHeading = this.target.facing;
    const turn = wrapAngle(this.desiredHeading - this.heading);
    const maxTurn = TURN_SPEED * input.dt;
    this.heading = wrapAngle(this.heading + Math.max(-maxTurn, Math.min(maxTurn, turn)));
    this.root.rotation.set(0, this.heading, 0);
    this.root.scale.setScalar(input.scale);

    const moving = this.moving;
    const activity = this.decide(input.state, moving, t, input.chat === true);
    if (this.rig) {
      this.rig.play(activity.clip, {
        once: activity.once,
        fade: moving ? 0.2 : 0.3,
        randomStart: !activity.once && activity.clip !== 'walk',
      });
      this.rig.update(input.dt);
      this.root.updateMatrixWorld(true);
      this.applyLayers(activity, input.dt, t);
      this.placeProps(activity, moving);
    }

    const atDesk = !moving && this.target?.kind === 'desk';
    if (this.desk) {
      const alive = input.state !== 'done' && input.state !== 'failed' && !input.ended;
      const working = atDesk && alive && (input.state === 'working' || input.state === 'checking' || input.state === 'reading');
      this.desk.setScreen(working ? 0.85 + 0.15 * Math.sin(t * 5) : atDesk && alive ? 0.12 : 0);
      this.desk.setSeated(atDesk && this.rig !== null && this.rig.current !== null && this.rig.seated(this.rig.current));
    }

    const fade = this.fadeAlpha(input, t);
    this.shown = fade;
    const spawn = this.readyAt === null ? 0 : Math.min(1, (t - this.readyAt) / SPAWN_FADE_S);
    const alpha = Math.min(fade, spawn);
    this.applyAlpha(alpha);
    this.applyTint(activity.tint, t);
    this.pickable = fade > 0.05;
    this.rings.select.visible = input.selected && fade > 0.05;
    this.rings.ask.visible = input.pending && fade > 0.05;
    this.props.pad.visible = false;

    const distance = input.camera.distanceTo(this.root.position);
    const lod: LabelLod = input.selected || input.following || distance < LABEL_NEAR ? 'near' : distance < LABEL_FAR ? 'mid' : 'far';
    this.label.update({
      name: input.name,
      state: input.state,
      icon: this.iconFor(input.state, input.pending),
      progress: input.state === 'testing',
      badge: this.badgeUntil > t && input.state !== 'done' && input.state !== 'failed' ? this.badge : null,
      selected: input.selected,
      pending: input.pending,
      alpha: alpha > 0.01 && !occluded(_b.copy(this.root.position).addScaledVector(UP, WAIST_HEIGHT * input.scale)) ? alpha : 0,
      lod,
      following: input.following,
      context: input.context,
    });
    this.props.coffee.scale.set(coffeeLevel(input.context), 1, coffeeLevel(input.context));
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRide();
    this.detach();
    this.label.dispose();
    this.root.removeFromParent();
  }

  private attach(model: LoadedModel | null, look: CharacterLook): void {
    this.detach();
    const body = new Group();
    if (model) {
      const object = cloneSkinned(model.scene);
      body.add(object);
      body.scale.setScalar(model.scale);
      body.position.copy(model.offset);
      const copies = new Map<Material, Material>();
      const convert = (material: Material): Material => {
        const known = copies.get(material);
        if (known) return known;
        if (!(material instanceof MeshStandardMaterial)) return material;
        const copy = material.clone();
        this.style(copy, model.custom, look);
        copies.set(material, copy);
        this.materials.push(copy);
        return copy;
      };
      object.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
        child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
        this.meshes.push(child);
      });
      this.rig = new GltfRig(object, model.clips, findBones(object, this.assets.manifest.bones), model.custom, model.seated);
    } else {
      const shirt = new Color(ROLE_SHIRTS[look.roleKind] ?? 0x5b6b7c);
      if (look.roleKind === 'dev') shirt.setHSL((hashString(this.key) % 360) / 360, 0.45, 0.4, SRGBColorSpace);
      const mannequin = buildMannequin(shirt, new Color(0x2c3442), new Color(this.pickVariety('Skin') ?? '#e3b08a'));
      body.add(mannequin.root);
      for (const material of mannequin.materials) {
        if (look.muted) material.color.copy(mute(material.color, 0.6));
        material.emissive.setRGB(0.55, 0.04, 0.04);
        material.emissiveIntensity = 0;
        this.materials.push(material);
      }
      mannequin.root.traverse((child) => {
        if (child instanceof Mesh) {
          child.castShadow = true;
          this.meshes.push(child);
        }
      });
      this.rig = new MannequinRig(mannequin);
    }
    this.body = body;
    this.root.add(body);
    this.readyAt = this.seconds;
    this.alphaLevel = -1;
    this.tintLevel = -1;
    this.castShadows = true;
  }

  private detach(): void {
    this.rig?.dispose();
    this.rig = null;
    if (this.body) this.body.removeFromParent();
    this.body = null;
    for (const material of this.materials) material.dispose();
    this.materials = [];
    this.meshes = [];
    this.readyAt = null;
  }

  private pickVariety(name: string): string | null {
    const palette = this.assets.manifest.variety[name];
    if (!palette || palette.length === 0) return null;
    return palette[hashString(`${this.key}|${name}`) % palette.length];
  }

  private style(material: MeshStandardMaterial, custom: boolean, look: CharacterLook): void {
    if (!custom) {
      const name = material.name;
      const lower = name.toLowerCase();
      if (/metal|gold|earring|visor/.test(lower)) {
        material.metalness = 0.6;
        material.roughness = 0.3;
      } else if (lower === 'eye') {
        material.metalness = 0;
        material.roughness = 0.25;
      } else {
        material.metalness = 0;
        material.roughness = Math.max(0.62, material.roughness);
      }
      for (const key of Object.keys(this.assets.manifest.variety)) {
        const pick = this.pickVariety(key);
        if (!pick) continue;
        if (name === key) material.color.set(pick);
        else if (name.startsWith(`${key}_`)) material.color.set(pick).multiplyScalar(0.82);
      }
      const spec = this.assets.spec(look.roleKind);
      if (spec) {
        const tint = spec.tint[name];
        if (tint) material.color.set(tint);
        if (spec.vary.includes(name)) material.color.setHSL((hashString(this.key) % 360) / 360, 0.42, 0.34, SRGBColorSpace);
      }
    }
    if (look.muted) material.color.copy(mute(material.color, 0.6));
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    material.emissive.setRGB(0.55, 0.04, 0.04);
    material.emissiveIntensity = 0;
  }

  private trackState(state: AgentState): void {
    if (state === this.lastState) return;
    this.lastState = state;
    this.stateStart = this.seconds;
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

  private cancelRide(): void {
    if (this.ride) this.lift?.cancel(this.key);
    this.ride = null;
    this.viaBridge = false;
  }

  private snapToTarget(): void {
    this.cancelRide();
    const target = this.target;
    if (!target) return;
    this.at = { floor: target.floor, x: target.x, z: target.z, lane: target.lane };
    this.path = [];
    this.transfer = null;
    this.pendingReplan = false;
    this.heading = target.facing;
    this.desiredHeading = target.facing;
  }

  private replan(): void {
    if (!this.target || !this.nav) return;
    if (this.transfer || this.ride?.phase === 'boarding' || this.ride?.phase === 'riding') {
      this.pendingReplan = true;
      return;
    }
    this.cancelRide();
    const path = planPath({ ...this.at }, this.target, this.nav);
    if (path === null) {
      this.snapToTarget();
      return;
    }
    this.path = path;
  }

  private walkTo(point: { x: number; z: number }, budget: number): number {
    const dx = point.x - this.at.x;
    const dz = point.z - this.at.z;
    const distance = Math.hypot(dx, dz);
    const reach = WALK_SPEED * budget;
    if (distance > 1e-4) this.desiredHeading = Math.atan2(dx, dz);
    if (distance <= reach) {
      this.at.x = point.x;
      this.at.z = point.z;
      return budget - distance / WALK_SPEED;
    }
    this.at.x += (dx / distance) * reach;
    this.at.z += (dz / distance) * reach;
    return -1;
  }

  private stepRide(ride: Ride, lift: SceneLift, budget: number): number {
    const { leg } = ride;
    if (ride.phase === 'approach' || ride.phase === 'boarding') {
      const point = ride.phase === 'approach' ? lift.landing(leg.from, leg.fromFace) : lift.cabin(leg.from);
      const left = this.walkTo(point, budget);
      if (left < 0) return -1;
      if (ride.phase === 'approach') {
        lift.request({ key: this.key, from: leg.from, to: leg.to, fromFace: leg.fromFace, toFace: leg.toFace });
        ride.phase = 'waiting';
      } else {
        lift.aboard(this.key);
        ride.phase = 'riding';
      }
      return left;
    }
    const event = lift.take(this.key);
    if (!event) return -1;
    if (event.type === 'cancelled') {
      this.snapToTarget();
      return -1;
    }
    if (event.type === 'boarded' && ride.phase === 'waiting') {
      ride.phase = 'boarding';
    } else if (event.type === 'arrived' && ride.phase === 'riding') {
      const exit = lift.cabin(leg.to);
      this.at = { floor: leg.to, x: exit.x, z: exit.z, lane: null };
      this.path.splice(0, leg.approach ? 2 : 1);
      this.ride = null;
      this.viaBridge = false;
      if (this.pendingReplan) {
        this.pendingReplan = false;
        this.replan();
      }
    }
    return budget;
  }

  private bridgeLanding(next: Waypoint): Waypoint | null {
    const lift = this.lift;
    const nav = this.nav;
    if (!lift || !nav) return null;
    const leg = liftLeg(next, this.path.slice(1), nav, lift.stops(), true);
    if (!leg || leg.approach) return null;
    const landing = lift.landing(next.floor, 'bridge');
    return { floor: next.floor, x: landing.x, z: landing.z, lane: null };
  }

  private advance(dt: number, resolve: Resolver): void {
    let budget = motionReduced() ? TELEPORT_S : dt;
    let guard = 0;
    while (budget > 1e-6 && guard < 24) {
      guard += 1;
      const lift = this.lift;
      if (!this.ride && lift && this.nav && this.transfer === null && this.path.length > 0) {
        const leg = liftLeg(this.at, this.path, this.nav, lift.stops(), this.viaBridge);
        if (leg) this.ride = { leg, phase: leg.approach ? 'approach' : 'boarding' };
        if (leg && !leg.approach) {
          lift.request({ key: this.key, from: leg.from, to: leg.to, fromFace: leg.fromFace, toFace: leg.toFace });
          this.ride!.phase = 'waiting';
        }
      }
      if (this.ride && lift) {
        budget = this.stepRide(this.ride, lift, budget);
        if (budget < 0) break;
        continue;
      }
      if (this.path.length === 0) break;
      const next = this.path[0];
      if (next.floor === this.at.floor && this.transfer === null) {
        this.at.lane = next.lane;
        const left = this.walkTo(next, budget);
        if (left < 0) break;
        this.path.shift();
        budget = left;
        continue;
      }
      const from = resolve(this.at.floor);
      const to = resolve(next.floor);
      if (!from || !to) {
        this.at = { ...next };
        this.path.shift();
        this.transfer = null;
        continue;
      }
      if (!this.transfer) {
        const vertical = Math.abs(from.y - to.y) > 0.05;
        const landing = vertical ? null : this.bridgeLanding(next);
        if (landing) this.path[0] = landing;
        this.transfer = { progress: 0, vertical, bridge: landing !== null };
      }
      const target = this.path[0];
      _a.set(from.x + this.at.x, from.y, from.z + this.at.z);
      _b.set(to.x + target.x, to.y, to.z + target.z);
      const length = Math.max(0.001, _a.distanceTo(_b));
      const speed = this.transfer.vertical ? LIFT_SPEED : WALK_SPEED;
      if (!this.transfer.vertical) this.desiredHeading = Math.atan2(_b.x - _a.x, _b.z - _a.z);
      this.transfer.progress += (speed * budget) / length;
      if (this.transfer.progress >= 1) {
        budget = ((this.transfer.progress - 1) * length) / speed;
        this.at = { floor: target.floor, x: target.x, z: target.z, lane: target.lane };
        this.path.shift();
        this.viaBridge = this.transfer.bridge;
        this.transfer = null;
        if (this.pendingReplan) {
          this.pendingReplan = false;
          this.replan();
        }
      } else {
        budget = 0;
      }
    }
  }

  private stepDown(): number {
    if (this.at.floor !== STREET || !this.nav || this.nav.mainGround === null) return 0;
    const street = this.nav.floors.get(STREET);
    if (!street) return 0;
    const distance = Math.hypot(this.at.x - street.exitX, this.at.z - AISLE_Z);
    return STEP_DOWN * Math.max(0, 1 - distance / STEP_REACH);
  }

  private worldPosition(resolve: Resolver, out: Vector3): Vector3 | null {
    if (this.ride?.phase === 'riding' && this.lift) {
      const from = resolve(this.ride.leg.from) ?? resolve(this.at.floor);
      if (!from) return null;
      const cabin = this.lift.cabin(this.ride.leg.from);
      return out.set(from.x + cabin.x, this.lift.position(), from.z + cabin.z);
    }
    const origin = resolve(this.at.floor);
    if (!origin) return null;
    out.set(origin.x + this.at.x, origin.y + this.stepDown(), origin.z + this.at.z);
    if (this.transfer && this.path.length > 0) {
      const next = this.path[0];
      const to = resolve(next.floor);
      if (to) {
        _b.set(to.x + next.x, to.y, to.z + next.z);
        out.lerp(_b, Math.min(1, this.transfer.progress));
      }
    }
    return out;
  }

  private decide(state: AgentState, moving: boolean, t: number, chat: boolean): Activity {
    const rig = this.rig;
    const has = (clip: LogicalClip): boolean => rig !== null && rig.has(clip);
    const pick = (...clips: LogicalClip[]): LogicalClip => clips.find(has) ?? 'idle';
    if (moving) return { ...BASE, clip: this.ride?.phase === 'waiting' || this.ride?.phase === 'riding' ? pick('idle') : pick('walk', 'run') };
    const atDesk = this.target?.kind === 'desk';
    if (chat && state === 'idle' && this.target?.kind === 'coffee') {
      const talk = has('talk');
      return { ...BASE, clip: talk ? 'talk' : pick('idle'), mug: 1, gesture: talk ? 0 : 1, headPitch: talk ? 0 : 0.11 * Math.sin(t * 6.5) };
    }
    switch (state) {
      case 'done':
        return { ...BASE, clip: pick('wave', 'idle'), once: true };
      case 'failed':
        return { ...BASE, clip: pick('hit', 'death', 'think', 'idle'), once: true, headPitch: 0.25 };
      case 'testing':
        return { ...BASE, clip: pick('interact', 'type', 'idle'), headPitch: 0.15 };
      case 'asking':
        return { ...BASE, clip: pick('wave', 'talk', 'idle') };
      case 'blocked':
        return { ...BASE, clip: pick('neutral', 'think', 'idle'), headPitch: 0.5, slump: 1, tint: true };
      case 'checking':
        if (atDesk) return { ...BASE, clip: pick('interact', 'type', 'idle'), stamp: true, headPitch: 0.25 };
        return { ...BASE, clip: pick('talk', 'idle'), gesture: has('talk') ? 0 : 1 };
      case 'reading':
        return { ...BASE, clip: pick('neutral', 'think', 'idle'), folder: 1, headPitch: 0.38 };
      case 'working':
        if (atDesk) {
          if (has('type')) return { ...BASE, clip: 'type' };
          return { ...BASE, clip: pick('idle'), typing: 1, headPitch: 0.14, headYaw: 0.28 };
        }
        return { ...BASE, clip: pick('talk', 'idle'), gesture: has('talk') ? 0 : 1, headPitch: has('talk') ? 0 : 0.08 * Math.sin(t * 6) };
      case 'talking': {
        const talk = has('talk');
        return { ...BASE, clip: talk ? 'talk' : pick('idle'), gesture: talk ? 0 : 1, headPitch: talk ? 0 : 0.11 * Math.sin(t * 6.5) };
      }
      default: {
        const sipping = t % 7 > 5.7;
        return { ...BASE, clip: pick('idle'), mug: 1, sip: sipping ? 1 : 0, headPitch: sipping ? -0.12 : 0 };
      }
    }
  }

  private direction(x: number, y: number, z: number): Vector3 {
    return _dir.set(x, y, z).normalize().applyQuaternion(this.root.quaternion);
  }

  private applyLayers(activity: Activity, dt: number, t: number): void {
    const rig = this.rig;
    if (!rig) return;
    const w = this.weights;
    w.typing = approach(w.typing, activity.typing, 7, dt);
    w.mug = approach(w.mug, activity.mug, 7, dt);
    w.sip = approach(w.sip, activity.sip, 5, dt);
    w.folder = approach(w.folder, activity.folder, 7, dt);
    w.gesture = approach(w.gesture, activity.gesture, 5, dt);
    w.slump = approach(w.slump, activity.slump, 4, dt);
    w.pitch = approach(w.pitch, activity.headPitch, 12, dt);
    w.yaw = approach(w.yaw, activity.headYaw, 6, dt);

    if (w.typing > 0.01) {
      rig.aim('upperArmL', 'lowerArmL', this.direction(0.16, -0.86, 0.48), w.typing);
      rig.aim('upperArmR', 'lowerArmR', this.direction(-0.16, -0.86, 0.48), w.typing);
      rig.aim('lowerArmL', 'handL', this.direction(-0.22, -0.3 + Math.sin(t * 13) * 0.08, 0.93), w.typing);
      rig.aim('lowerArmR', 'handR', this.direction(0.22, -0.3 + Math.sin(t * 13 + 2.2) * 0.08, 0.93), w.typing);
    }
    if (w.folder > 0.01) {
      rig.aim('upperArmL', 'lowerArmL', this.direction(0.1, -0.92, 0.38), w.folder);
      rig.aim('upperArmR', 'lowerArmR', this.direction(-0.1, -0.92, 0.38), w.folder);
      rig.aim('lowerArmL', 'handL', this.direction(-0.36, 0.36, 0.86), w.folder);
      rig.aim('lowerArmR', 'handR', this.direction(0.36, 0.36, 0.86), w.folder);
    }
    if (w.mug > 0.01) {
      rig.aim('upperArmR', 'lowerArmR', this.direction(-0.14, -0.95, 0.24), w.mug);
      const sx = 0.12 + (0.45 - 0.12) * w.sip;
      const sy = 0.3 + (0.8 - 0.3) * w.sip;
      const sz = 0.95 + (0.4 - 0.95) * w.sip;
      rig.aim('lowerArmR', 'handR', this.direction(sx, sy, sz), w.mug);
    }
    if (w.gesture > 0.01) {
      rig.aim('upperArmL', 'lowerArmL', this.direction(0.22, -0.9, 0.3), w.gesture * 0.6);
      rig.aim('lowerArmL', 'handL', this.direction(-0.05, 0.2 + Math.sin(t * 3.1) * 0.3, 0.95), w.gesture * 0.75);
    }
    if (w.slump > 0.01) {
      rig.aim('upperArmL', 'lowerArmL', this.direction(0.06, -1, 0.04), w.slump * 0.6);
      rig.aim('upperArmR', 'lowerArmR', this.direction(-0.06, -1, 0.04), w.slump * 0.6);
    }
    if (Math.abs(w.pitch) > 0.002) {
      _axis.set(1, 0, 0).applyQuaternion(this.root.quaternion);
      rig.turn('head', _axis, w.pitch);
    }
    if (Math.abs(w.yaw) > 0.002) rig.turn('head', UP, w.yaw);
  }

  private placeProps(activity: Activity, moving: boolean): void {
    const rig = this.rig;
    const { mug, folder, stamp } = this.props;
    mug.visible = false;
    folder.visible = false;
    stamp.visible = false;
    if (!rig || moving) return;
    if (this.weights.mug > 0.5 && rig.handPosition('R', _hand)) {
      this.root.worldToLocal(_hand);
      mug.position.set(_hand.x, _hand.y - 0.02, _hand.z + 0.015);
      mug.visible = true;
    }
    if (this.weights.folder > 0.5 && rig.handPosition('L', _handL) && rig.handPosition('R', _handR)) {
      this.root.worldToLocal(_handL);
      this.root.worldToLocal(_handR);
      folder.position.addVectors(_handL, _handR).multiplyScalar(0.5);
      folder.position.y += 0.03;
      folder.position.z += 0.04;
      folder.rotation.set(-0.95, 0, 0);
      folder.visible = true;
    }
    if (activity.stamp && rig.handPosition('R', _hand)) {
      this.root.worldToLocal(_hand);
      stamp.position.set(_hand.x, _hand.y - 0.07, _hand.z);
      stamp.visible = true;
    }
  }

  private fadeAlpha(input: FrameInput, t: number): number {
    if (this.leaving) {
      if (this.moving || input.hold) {
        this.exitAt = null;
        return 1;
      }
      if (this.exitAt === null) this.exitAt = t;
      const alpha = Math.max(0, 1 - (t - this.exitAt) / EXIT_FADE_S);
      if (alpha <= 0) this.left = true;
      return alpha;
    }
    this.exitAt = null;
    let alpha = 1;
    if (!input.away && (input.state === 'done' || input.state === 'failed')) {
      const hold = input.state === 'done' ? DONE_HOLD_S : FAILED_HOLD_S;
      alpha = Math.max(0, Math.min(1, 1 - (t - this.stateStart - hold) / FADE_S));
    }
    if (input.ended) alpha = Math.min(alpha, ENDED_ALPHA);
    return alpha;
  }

  private applyAlpha(alpha: number): void {
    const level = Math.round(alpha * 40) / 40;
    if (level === this.alphaLevel) return;
    this.alphaLevel = level;
    const transparent = level < 0.999;
    for (const material of this.materials) {
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      material.opacity = level;
      material.depthWrite = level > 0.6;
    }
    if (this.body) this.body.visible = level > 0.01;
    const cast = level > 0.35;
    if (cast !== this.castShadows) {
      this.castShadows = cast;
      for (const mesh of this.meshes) mesh.castShadow = cast;
    }
  }

  private applyTint(on: boolean, t: number): void {
    const level = on ? Math.round((0.32 + 0.18 * Math.sin(t * 4)) * 50) / 50 : 0;
    if (level === this.tintLevel) return;
    this.tintLevel = level;
    for (const material of this.materials) material.emissiveIntensity = level;
  }

  private iconFor(state: AgentState, pending: boolean): LabelIcon | null {
    if (state === 'asking' || pending) return 'ask';
    switch (state) {
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
}
