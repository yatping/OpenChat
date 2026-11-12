/**
 * Which language the widget speaks. Shared by the loader, so it stays tiny: the full strings are in strings.ts,
 * in the chat bundle. See docs/architecture/widget.md#languages.
 */
export const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
export type Locale = (typeof LOCALES)[number];

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

/** The first candidate the widget speaks, in order of preference, or English. */
export function pickLocale(candidates: readonly (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale) return locale;
  }
  return 'en';
}

/** What the page says about its visitor: the page's language, then the browser's. */
export function pageLanguages(): string[] {
  return [document.documentElement.lang, ...(navigator.languages ?? [navigator.language])];
}

/** The button's label before the chat bundle arrives. */
export const OPEN_LABEL: Record<Locale, string> = {
  en: 'Open chat',
  es: 'Abrir chat',
  fr: 'Ouvrir le chat',
  de: 'Chat öffnen',
  it: 'Apri la chat',
  pt: 'Abrir o chat',
  nl: 'Chat openen',
  ja: 'チャットを開く',
  ko: '채팅 열기',
  'zh-Hans': '打开聊天',
  'zh-Hant': '開啟聊天',
};
