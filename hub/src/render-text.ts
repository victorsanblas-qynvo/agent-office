import { hubEn } from '../../shared/i18n/en';
import { hubEs } from '../../shared/i18n/es';
import type { HubText } from './types';

export type TextLang = 'es' | 'en';

const DICTIONARIES: Record<TextLang, Record<string, string>> = { es: hubEs, en: hubEn };

function interpolate(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

// Pure: a HubText as plain text (Spanish unless asked for English), for what the hub itself has to read or index (search). Raw text as is,
// null as '', a key translated after its nested parameters. It never throws: an unknown key comes out as the key.
export function renderHubText(value: HubText | null | undefined, lang: TextLang = 'es'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || typeof value.key !== 'string') return '';
  const params: Record<string, string | number> = {};
  const raw: unknown = value.params;
  if (typeof raw === 'object' && raw !== null) {
    for (const [name, param] of Object.entries(raw)) {
      if (typeof param === 'object' && param !== null) params[name] = renderHubText(param as HubText, lang);
      else if (typeof param === 'string' || typeof param === 'number') params[name] = param;
    }
  }
  return interpolate(DICTIONARIES[lang][value.key] ?? value.key, params);
}
