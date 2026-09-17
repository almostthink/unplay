/**
 * Minimal i18n engine shared by every game in this repo.
 *
 * Each game registers its own dictionaries at boot; only the handful of
 * duration units used by `formatTime` are built in, so platform helpers keep
 * working before a game has registered anything.
 */

export type Lang = 'ru' | 'en' | 'tr';
export type Dict = Record<string, string>;

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English',
  tr: 'Türkçe',
};

const BUILT_IN: Record<Lang, Dict> = {
  ru: { 'time.d': '{n} д', 'time.h': '{n} ч', 'time.m': '{n} мин', 'time.s': '{n} с' },
  en: { 'time.d': '{n}d', 'time.h': '{n}h', 'time.m': '{n}m', 'time.s': '{n}s' },
  tr: { 'time.d': '{n}g', 'time.h': '{n}s', 'time.m': '{n}d', 'time.s': '{n}sn' },
};

let dicts: Record<Lang, Dict> = { ...BUILT_IN };
let current: Lang = 'ru';

/** Merges a game's strings over the built-in ones. */
export function registerStrings(strings: Record<Lang, Dict>): void {
  dicts = {
    ru: { ...BUILT_IN.ru, ...strings.ru },
    en: { ...BUILT_IN.en, ...strings.en },
    tr: { ...BUILT_IN.tr, ...strings.tr },
  };
}

/** Accepts anything the platform reports ("ru", "en-US", undefined). */
export function setLang(lang: string | undefined): Lang {
  const short = (lang || '').slice(0, 2).toLowerCase();
  current = short === 'ru' ? 'ru' : short === 'tr' ? 'tr' : 'en';
  document.documentElement.lang = current;
  return current;
}

export function getLang(): Lang {
  return current;
}

/** Translates `key`, substituting `{name}` placeholders from `params`. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = dicts[current][key] ?? dicts.en[key] ?? dicts.ru[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}
