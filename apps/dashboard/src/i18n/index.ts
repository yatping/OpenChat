/**
 * The dashboard's words. The language is the one chosen in the dashboard, kept in this browser, or else the browser's
 * own. Choosing another reloads the page. What the server says, such as an error, comes in English, and what people
 * type, such as tag names, is shown as they wrote it. See docs/architecture/dashboard.md#languages.
 */
import { Fragment, createElement, type ReactNode } from 'react';
import { de } from './de';
import { en, type Messages } from './en';
import { es } from './es';
import { fr } from './fr';
import { it } from './it';
import { ja } from './ja';
import { ko } from './ko';
import { pickLocale, type Locale } from './locales';
import { nl } from './nl';
import { pt } from './pt';
import { zhHans } from './zh-hans';
import { zhHant } from './zh-hant';

export type MessageKey = keyof typeof en;
type Plural = { [K in MessageKey]: K extends `${infer Base}One` ? (`${Base}Other` extends MessageKey ? Base : never) : never }[MessageKey];

export const CATALOGS: Record<Locale, Messages> = { en, es, fr, de, it, pt, nl, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };

export const LANGUAGE_PREFERENCE = 'openchat.language';

let current: Locale = 'en';

export function setLocale(locale: Locale): void {
  current = locale;
}

export const getLocale = (): Locale => current;

/** At start: the language chosen here before, or the browser's. Also tells the page, for screen readers. */
export function startLocale(saved: string | null, browser: readonly string[]): Locale {
  setLocale(pickLocale([saved, ...browser]));
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return current;
}

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));

/** One message, with `{name}` placeholders filled in. */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const text = CATALOGS[current][key] ?? en[key];
  return values ? fill(text, values) : text;
}

/** A message with a count, in the plural form the language uses for it. `{count}` is filled in. */
export function tn(base: Plural, count: number, values: Record<string, string | number> = {}): string {
  const form = new Intl.PluralRules(current).select(count) === 'one' ? 'One' : 'Other';
  return t(`${base}${form}` as MessageKey, { ...values, count });
}

/** A message whose placeholders are elements, such as a name in bold or a time, in the order the language puts them. */
export function tNode(key: MessageKey, values: Record<string, ReactNode>): ReactNode {
  const parts = (CATALOGS[current][key] ?? en[key]).split(/\{(\w+)\}/g);
  return createElement(Fragment, null, ...parts.map((part, index) => (index % 2 === 0 ? part : createElement(Fragment, { key: index }, part in values ? values[part] : `{${part}}`))));
}

/** For Intl: dates and times read the way the words around them do. */
export const intlLocale = (): string => current;
