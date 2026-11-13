/**
 * The dashboard's languages: the same as the widget's, in apps/widget/src/locale.ts, and as the iPhone app's, so that a
 * team is offered the same ones as its visitors. Each is named in itself, as someone would look for it.
 */
export const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['nl', 'Nederlands'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh-Hans', '简体中文'],
  ['zh-Hant', '繁體中文'],
] as const;

export type Locale = (typeof LANGUAGES)[number][0];
export const LOCALES: readonly Locale[] = LANGUAGES.map(([code]) => code);

/** Traditional script for Taiwan, Hong Kong and Macau, and when asked for by name. */
const TRADITIONAL = /^zh-(hant|tw|hk|mo)\b/;

/** The supported language for one tag, such as `pt-BR` or `zh-HK`, or null. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase().replace(/_/g, '-');
  if (lower.startsWith('zh')) return TRADITIONAL.test(lower) ? 'zh-Hant' : 'zh-Hans';
  const base = lower.split('-')[0];
  return (LOCALES as readonly string[]).includes(base!) ? (base as Locale) : null;
}

/** The first candidate the dashboard speaks, in order of preference, or English. */
export function pickLocale(candidates: readonly (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale) return locale;
  }
  return 'en';
}
