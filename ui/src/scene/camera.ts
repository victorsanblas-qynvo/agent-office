import { Box3, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { currentLang, t } from '../i18n';
import { motionReduced } from '../motion';

export type FloorButton = { slug: string; label: string; accent: string; annex: boolean };

export const OVERVIEW = '';

export type CameraCallbacks = {
  onFloor(slug: string): void;
  onOverview(): void;
  onStopFollow(): void;
};

type Tween = { fromPosition: Vector3; toPosition: Vector3; fromTarget: Vector3; toTarget: Vector3; elapsed: number; duration: number };

type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

const PINCH_SPEED = 0.01;
const WHEEL_LINE_PX = 16;

const _size = new Vector3();
const _center = new Vector3();
const _delta = new Vector3();
const _clamped = new Vector3();
const _right = new Vector3();
const _offset = new Vector3();
const _shift = new Vector3();
const _hit = new Vector3();
const _dir = new Vector3();
const _ndc = new Vector2();
const _plane = new Plane();
const _ray = new Raycaster();

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(38, 1, 0.25, 600);
  readonly controls: OrbitControls;
  private readonly bounds = new Box3();
  private tween: Tween | null = null;
  private followKey: string | null = null;
  private readonly nav: HTMLElement;
  private readonly followBox: HTMLElement;
  private readonly followName: HTMLElement;
  private readonly followPrefix = document.createTextNode('');
  private readonly followStop: HTMLButtonElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private floorsSignature = '';
  private activeSlug: string | null = null;
  private hasView = false;
  private gestureDistance = 0;
  private gesturing = false;
  private readonly surface: HTMLElement;
  preset: string | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly domElement: HTMLElement,
    private readonly callbacks: CameraCallbacks,
    private readonly card: HTMLElement,
  ) {
    this.camera.position.set(6, 9, 30);
    this.controls = new OrbitControls(this.camera, domElement);
    const controls = this.controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 2.5;
    controls.maxDistance = 90;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minAzimuthAngle = -1.35;
    controls.maxAzimuthAngle = 1.35;
    controls.rotateSpeed = 0.7;
    controls.panSpeed = 0.9;
    controls.addEventListener('start', this.onStart);
    this.surface = domElement.parentElement ?? domElement;
    this.surface.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
    this.surface.addEventListener('gesturestart', this.onGestureStart, { passive: false });
    this.surface.addEventListener('gesturechange', this.onGestureChange, { passive: false });
    this.surface.addEventListener('gestureend', this.onGestureEnd);

    this.nav = document.createElement('nav');
    this.nav.className = 'scene-floors';

    this.followBox = document.createElement('div');
    this.followBox.className = 'scene-follow';
    this.followBox.hidden = true;
    const followText = document.createElement('span');
    followText.append(this.followPrefix);
    this.followName = document.createElement('strong');
    followText.append(this.followName);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'scene-follow-stop';
    stop.textContent = '×';
    this.followStop = stop;
    stop.addEventListener('click', () => this.callbacks.onStopFollow());
    this.followBox.append(followText, stop);
    overlay.append(this.nav, this.followBox);
    this.relabel();
  }

  relabel(): void {
    this.nav.setAttribute('aria-label', t('scene.floors'));
    this.followPrefix.textContent = t('scene.following');
    this.followStop.title = t('scene.stopFollow');
  }

  get following(): string | null {
    return this.followKey;
  }

  get target(): Vector3 {
    return this.controls.target;
  }

  setBounds(box: Box3): void {
    this.bounds.copy(box);
    const size = box.getSize(_size);
    this.controls.maxDistance = Math.max(40, size.length() * 2.2);
    this.camera.far = Math.max(320, size.length() * 8);
    this.camera.updateProjectionMatrix();
    if (!this.hasView && !box.isEmpty()) {
      this.hasView = true;
      this.focusBox(box, { duration: 0 });
      this.preset = OVERVIEW;
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  setFloors(items: readonly FloorButton[]): void {
    const signature = [currentLang(), ...items.map((item) => `${item.slug}|${item.label}|${item.accent}|${item.annex ? 1 : 0}`)].join('\u0000');
    if (signature === this.floorsSignature) return;
    this.floorsSignature = signature;
    this.buttons.clear();
    const overview = document.createElement('button');
    overview.type = 'button';
    overview.className = 'scene-floor-btn is-overview';
    overview.textContent = t('scene.building');
    overview.addEventListener('click', () => this.callbacks.onOverview());
    const list: HTMLElement[] = [overview, this.card];
    let annexStarted = false;
    for (const item of items) {
      if (item.annex && !annexStarted) {
        annexStarted = true;
        const divider = document.createElement('span');
        divider.className = 'scene-floor-divider';
        divider.textContent = t('scene.annex');
        list.push(divider);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-floor-btn';
      button.style.setProperty('--c', item.accent);
      const dot = document.createElement('span');
      dot.className = 'scene-floor-dot';
      const text = document.createElement('span');
      text.className = 'scene-floor-label';
      text.textContent = item.label;
      button.title = item.label;
      button.append(dot, text);
      button.addEventListener('click', () => this.callbacks.onFloor(item.slug));
      this.buttons.set(item.slug, button);
      list.push(button);
    }
    const hint = document.createElement('p');
    hint.className = 'scene-hint';
    hint.textContent = t('scene.gestures');
    list.push(hint);
    this.nav.replaceChildren(...list);
    this.activeSlug = null;
  }

  setActive(slug: string | null): void {
    if (slug === this.activeSlug) return;
    const previous = this.activeSlug === null ? undefined : this.buttons.get(this.activeSlug);
    previous?.classList.remove('active');
    previous?.removeAttribute('aria-current');
    this.activeSlug = slug;
    const next = slug === null ? undefined : this.buttons.get(slug);
    next?.classList.add('active');
    next?.setAttribute('aria-current', 'true');
  }

  focusBox(box: Box3, options: { azimuth?: number; elevation?: number; duration?: number; margin?: number } = {}): void {
    if (box.isEmpty()) return;
    const size = box.getSize(_size);
    const center = box.getCenter(_center).clone();
    const azimuth = options.azimuth ?? 0.22;
    const elevation = options.elevation ?? 0.24;
    const vertical = (this.camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    const margin = options.margin ?? 1.12;
    const fitWidth = (size.x / 2) / Math.tan(horizontal / 2);
    const fitHeight = (size.y / 2) / Math.tan(vertical / 2);
    const distance = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance + 1, Math.max(fitWidth, fitHeight) * margin + size.z / 2));
    const direction = new Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    const position = center.clone().addScaledVector(direction, distance);
    this.moveTo(position, center, options.duration ?? 0.9);
  }

  moveTo(position: Vector3, target: Vector3, duration: number): void {
    if (duration <= 0 || motionReduced()) {
      this.tween = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      elapsed: 0,
      duration,
    };
  }

  follow(key: string, name: string): void {
    this.followKey = key;
    this.tween = null;
    this.preset = null;
    this.followName.textContent = name;
    this.followBox.hidden = false;
  }

  setFollowName(name: string): void {
    if (this.followName.textContent !== name) this.followName.textContent = name;
  }

  stopFollow(): void {
    this.followKey = null;
    this.followBox.hidden = true;
  }

  update(dt: number, followPoint: Vector3 | null): void {
    if (this.tween) {
      const tween = this.tween;
      tween.elapsed += dt;
      const k = ease(Math.min(1, tween.elapsed / tween.duration));
      this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, k);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.elapsed >= tween.duration) this.tween = null;
    }
    if (this.followKey && followPoint) {
      _delta.copy(followPoint).sub(this.controls.target).multiplyScalar(1 - Math.exp(-dt * 5));
      this.controls.target.add(_delta);
      this.camera.position.add(_delta);
    }
    this.controls.update();
    this.clampTarget();
  }

  dispose(): void {
    this.controls.removeEventListener('start', this.onStart);
    this.surface.removeEventListener('wheel', this.onWheel, { capture: true });
    this.surface.removeEventListener('gesturestart', this.onGestureStart);
    this.surface.removeEventListener('gesturechange', this.onGestureChange);
    this.surface.removeEventListener('gestureend', this.onGestureEnd);
    this.controls.dispose();
    this.nav.remove();
    this.followBox.remove();
  }

  private clampTarget(): void {
    if (this.bounds.isEmpty()) return;
    const target = this.controls.target;
    _clamped.set(
      Math.min(this.bounds.max.x + 4, Math.max(this.bounds.min.x - 4, target.x)),
      Math.min(this.bounds.max.y + 2, Math.max(0, target.y)),
      Math.min(this.bounds.max.z + 6, Math.max(this.bounds.min.z - 2, target.z)),
    );
    if (_clamped.equals(target)) return;
    _delta.subVectors(_clamped, target);
    target.add(_delta);
    this.camera.position.add(_delta);
  }

  private readonly onStart = (): void => {
    this.tween = null;
    this.preset = null;
  };

  private takeControl(): void {
    this.tween = null;
    this.preset = null;
    if (this.followKey) this.callbacks.onStopFollow();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.target instanceof Node && this.overlay.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? this.domElement.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      if (this.gesturing) return;
      this.takeControl();
      this.zoomAt(event.clientX, event.clientY, Math.exp(event.deltaY * unit * PINCH_SPEED));
      return;
    }
    this.takeControl();
    this.pan(event.deltaX * unit, event.deltaY * unit);
  };

  private readonly onGestureStart = (event: Event): void => {
    event.preventDefault();
    this.gesturing = true;
    this.takeControl();
    this.gestureDistance = this.camera.position.distanceTo(this.controls.target);
  };

  private readonly onGestureChange = (event: Event): void => {
    event.preventDefault();
    const gesture = event as GestureLike;
    if (!gesture.scale || this.gestureDistance <= 0) return;
    const current = this.camera.position.distanceTo(this.controls.target);
    const rect = this.domElement.getBoundingClientRect();
    const x = gesture.clientX ?? rect.left + rect.width / 2;
    const y = gesture.clientY ?? rect.top + rect.height / 2;
    this.zoomAt(x, y, this.gestureDistance / gesture.scale / current);
  };

  private readonly onGestureEnd = (): void => {
    this.gesturing = false;
  };

  private pan(dx: number, dy: number): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const height = Math.max(1, this.domElement.clientHeight);
    const perPixel = (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
    _right.setFromMatrixColumn(this.camera.matrix, 0);
    _right.y = 0;
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    else _right.normalize();
    _shift.copy(_right).multiplyScalar(dx * perPixel);
    _shift.y -= dy * perPixel;
    this.controls.target.add(_shift);
    this.camera.position.add(_shift);
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const target = this.controls.target;
    _offset.subVectors(this.camera.position, target);
    const distance = _offset.length();
    const next = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, distance * factor));
    if (Math.abs(next - distance) < 1e-4) return;
    const rect = this.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    _ray.setFromCamera(_ndc, this.camera);
    this.camera.getWorldDirection(_dir);
    _plane.setFromNormalAndCoplanarPoint(_dir, target);
    if (_ray.ray.intersectPlane(_plane, _hit)) {
      _shift.subVectors(_hit, target).multiplyScalar(1 - next / distance);
      target.add(_shift);
    }
    this.camera.position.copy(target).addScaledVector(_offset.normalize(), next);
  }
}
