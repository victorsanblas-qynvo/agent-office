import { readJson, writeJson } from './prefs';

export type MotionPref = 'auto' | 'reduced' | 'full';

export const MOTION_KEY = 'agent-office.motion';
export const MOTION_OPTIONS: readonly MotionPref[] = ['auto', 'reduced', 'full'];
export const MOTION_DEFAULT: MotionPref = 'auto';

// Seconds between ambient updates (sky check, clouds, lamps) while motion is reduced.
export const REDUCED_AMBIENT_S = 60;

export function normalizeMotion(stored: unknown): MotionPref {
  return MOTION_OPTIONS.find((option) => option === stored) ?? MOTION_DEFAULT;
}

export function readMotion(): MotionPref {
  return normalizeMotion(readJson(MOTION_KEY));
}

// Pure: the motion the scenes show, given the preference and whether the system asks for reduced motion.
export function effectiveMotion(pref: MotionPref, systemReduced: boolean): 'reduced' | 'full' {
  if (pref === 'auto') return systemReduced ? 'reduced' : 'full';
  return pref;
}

const QUERY = '(prefers-reduced-motion: reduce)';

// The motion preference, shared by the stylesheet, the 2D and the 3D view and the settings that change it.
export class MotionStore {
  private value: MotionPref;
  private systemReduced = false;
  private readonly listeners = new Set<() => void>();

  constructor(initial: MotionPref = readMotion()) {
    this.value = initial;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    this.systemReduced = media.matches;
    media.addEventListener('change', (event) => {
      this.systemReduced = event.matches;
      for (const listener of [...this.listeners]) listener();
    });
  }

  get(): MotionPref {
    return this.value;
  }

  reduced(): boolean {
    return effectiveMotion(this.value, this.systemReduced) === 'reduced';
  }

  set(next: MotionPref): void {
    this.value = next;
    writeJson(MOTION_KEY, next);
    this.apply();
    for (const listener of [...this.listeners]) listener();
  }

  // Marks the document so the stylesheet follows the preference; 'auto' leaves it to prefers-reduced-motion.
  apply(): void {
    if (typeof document === 'undefined' || !document.documentElement?.dataset) return;
    document.documentElement.dataset.motion = this.value;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const motion = new MotionStore();

// Cheap: both scenes read it every frame and at every transition.
export function motionReduced(): boolean {
  return motion.reduced();
}

// Seconds between two runs of a periodic ambient check: the base one, or no more often than once a minute.
export function ambientInterval(base: number): number {
  return motionReduced() ? Math.max(base, REDUCED_AMBIENT_S) : base;
}
