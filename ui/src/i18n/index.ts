import { en } from './en';
import { es, type MessageKey, type Messages } from './es';

export type { MessageKey, Messages } from './es';

export type Lang = 'es' | 'en';
export type Params = Record<string, string | number>;

// Prefixes that have both `.one` and `.other` keys.
export type PluralKey = { [K in MessageKey]: K extends `${infer P}.one` ? P : never }[MessageKey];

export type Translator = {
  t(key: MessageKey, params?: Params): string;
  plural(key: PluralKey, n: number, params?: Params): string;
};

export const LANGS: readonly Lang[] = ['es', 'en'];
export const LANG_NAMES: Record<Lang, string> = { es: 'Español', en: 'English' };
export const LANG_KEY = 'agent-office.lang';

const DICTIONARIES: Record<Lang, Messages> = { es, en };

export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function createTranslator(dict: Messages): Translator {
  const t = (key: MessageKey, params?: Params): string => interpolate(dict[key] ?? key, params);
  const plural = (key: PluralKey, n: number, params?: Params): string =>
    t(`${key}.${n === 1 ? 'one' : 'other'}` as MessageKey, { n, ...params });
  return { t, plural };
}

export function translatorFor(language: Lang): Translator {
  return createTranslator(DICTIONARIES[language]);
}

let lang: Lang = 'es';
let active = createTranslator(es);

function isLang(value: unknown): value is Lang {
  return LANGS.includes(value as Lang);
}

export function readStoredLang(): Lang {
  if (typeof localStorage === 'undefined') return 'es';
  try {
    const stored = localStorage.getItem(LANG_KEY);
    return isLang(stored) ? stored : 'es';
  } catch {
    return 'es';
  }
}

export function currentLang(): Lang {
  return lang;
}

export function applyLang(next: Lang): void {
  lang = next;
  active = createTranslator(DICTIONARIES[next]);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function storeLang(next: Lang): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // Blocked storage: the choice lasts for this session only.
  }
}

export function t(key: MessageKey, params?: Params): string {
  return active.t(key, params);
}

export function plural(key: PluralKey, n: number, params?: Params): string {
  return active.plural(key, n, params);
}
