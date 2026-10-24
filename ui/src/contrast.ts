import { readJson, writeJson } from './prefs';

export type ContrastPref = 'auto' | 'high' | 'normal';

export const CONTRAST_KEY = 'agent-office.contrast';
export const CONTRAST_OPTIONS: readonly ContrastPref[] = ['auto', 'high', 'normal'];
export const CONTRAST_DEFAULT: ContrastPref = 'auto';

export function normalizeContrast(stored: unknown): ContrastPref {
  return CONTRAST_OPTIONS.find((option) => option === stored) ?? CONTRAST_DEFAULT;
}

export function readContrast(): ContrastPref {
  return normalizeContrast(readJson(CONTRAST_KEY));
}

// Pure: the contrast the panel shows, given the preference and whether the system asks for more contrast.
export function effectiveContrast(pref: ContrastPref, systemMore: boolean): 'high' | 'normal' {
  if (pref === 'auto') return systemMore ? 'high' : 'normal';
  return pref;
}

const QUERY = '(prefers-contrast: more)';

// The contrast preference, shared by the stylesheet and the settings that change it.
export class ContrastStore {
  private value: ContrastPref;
  private systemMore = false;
  private readonly listeners = new Set<() => void>();

  constructor(initial: ContrastPref = readContrast()) {
    this.value = initial;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    this.systemMore = media.matches;
    media.addEventListener('change', (event) => {
      this.systemMore = event.matches;
      this.apply();
      for (const listener of [...this.listeners]) listener();
    });
  }

  get(): ContrastPref {
    return this.value;
  }

  effective(): 'high' | 'normal' {
    return effectiveContrast(this.value, this.systemMore);
  }

  set(next: ContrastPref): void {
    this.value = next;
    writeJson(CONTRAST_KEY, next);
    this.apply();
    for (const listener of [...this.listeners]) listener();
  }

  // Marks the document with the contrast in force; the stylesheet only redefines tokens under "high".
  apply(): void {
    if (typeof document === 'undefined' || !document.documentElement?.dataset) return;
    document.documentElement.dataset.contrast = this.effective();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const contrast = new ContrastStore();
