import { describe, expect, it } from 'vitest';
import { LOCALES as WIDGET_LOCALES } from '../../../widget/src/locale';
import { en } from './en';
import { CATALOGS, setLocale, startLocale, t, tn } from './index';
import { LOCALES, matchLocale, pickLocale } from './locales';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('dashboard languages', () => {
  it('offers the same languages as the widget', () => {
    expect([...LOCALES]).toEqual([...WIDGET_LOCALES]);
  });

  it('matches browser tags to a language', () => {
    expect(matchLocale('pt-BR')).toBe('pt');
    expect(matchLocale('de_AT')).toBe('de');
    expect(matchLocale('zh-TW')).toBe('zh-Hant');
    expect(matchLocale('zh-HK')).toBe('zh-Hant');
    expect(matchLocale('zh-CN')).toBe('zh-Hans');
    expect(matchLocale('zh')).toBe('zh-Hans');
    expect(matchLocale('sv-SE')).toBeNull();
    expect(pickLocale([null, 'sv', 'ja-JP'])).toBe('ja');
    expect(pickLocale(['sv'])).toBe('en');
  });

  it('prefers the language chosen here over the browser', () => {
    expect(startLocale('fr', ['de-DE'])).toBe('fr');
    expect(startLocale(null, ['de-DE'])).toBe('de');
    setLocale('en');
  });

  for (const locale of LOCALES) {
    it(`has every message, with the same placeholders, in ${locale}`, () => {
      const catalog = CATALOGS[locale];
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        const translated = catalog[key as keyof typeof en];
        expect(translated.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(translated), `${locale}.${key}`).toEqual(placeholders(text));
      }
    });
  }

  it('pairs every plural', () => {
    // typingOne and typingMany choose by how many people, not by a number's plural rule.
    for (const key of Object.keys(en)) {
      const base = key.slice(0, -3);
      if (key.endsWith('One') && !(`${base}Many` in en)) expect(en, key).toHaveProperty(`${base}Other`);
    }
  });

  it('fills placeholders and picks plural forms', () => {
    setLocale('en');
    expect(tn('years', 1)).toBe('1 year');
    expect(tn('years', 2)).toBe('2 years');
    setLocale('de');
    expect(t('workspaceNamed', { name: 'Acme' })).toBe('Arbeitsbereich Acme');
    expect(tn('years', 1)).toBe('1 Jahr');
    setLocale('en');
  });
});
