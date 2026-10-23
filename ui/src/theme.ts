import { readJson, writeJson } from './prefs';

export type ThemePref = 'auto' | 'light' | 'dark';

export const THEME_KEY = 'agent-office.theme';
export const THEME_OPTIONS: readonly ThemePref[] = ['auto', 'light', 'dark'];
export const THEME_DEFAULT: ThemePref = 'auto';

export function normalizeTheme(stored: unknown): ThemePref {
  return THEME_OPTIONS.find((option) => option === stored) ?? THEME_DEFAULT;
}

export function readTheme(): ThemePref {
  return normalizeTheme(readJson(THEME_KEY));
}

// Pure: the theme the panel shows, given the preference and whether the system prefers dark.
export function effectiveTheme(pref: ThemePref, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'auto') return systemDark ? 'dark' : 'light';
  return pref;
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme(): 'light' | 'dark' {
  return effectiveTheme(theme.get(), systemPrefersDark());
}

// The theme preference, shared by the stylesheet, the 2D and the 3D view and the settings that change it.
export class ThemeStore {
  private value: ThemePref;
  private readonly listeners = new Set<() => void>();

  constructor(initial: ThemePref = readTheme()) {
    this.value = initial;
  }

  get(): ThemePref {
    return this.value;
  }

  set(next: ThemePref): void {
    this.value = next;
    writeJson(THEME_KEY, next);
    this.apply();
    for (const listener of [...this.listeners]) listener();
  }

  // Marks the document so the stylesheet follows the preference; 'auto' leaves it to prefers-color-scheme.
  apply(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = this.value;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const theme = new ThemeStore();
