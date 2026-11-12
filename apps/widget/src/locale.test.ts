// eslint-disable-next-line no-restricted-imports -- A test, never bundled: it keeps the widget's languages in step with the API's.
import { WidgetSettingsSchema } from '@openchat/api-contracts';
import { describe, expect, it } from 'vitest';
import { LOCALES, matchLocale, OPEN_LABEL, pickLocale } from './locale';
import { formatSize, TRANSLATIONS } from './strings';

describe('choosing a language', () => {
  it.each([
    ['en-GB', 'en'],
    ['pt-BR', 'pt'],
    ['PT_pt', 'pt'],
    ['fr', 'fr'],
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh-Hans-CN', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-Hant-HK', 'zh-Hant'],
    ['ar', null],
    ['', null],
    [undefined, null],
  ])('%s is %s', (tag, locale) => {
    expect(matchLocale(tag)).toBe(locale);
  });

  it('takes the first language it speaks, and English when there is none', () => {
    expect(pickLocale([undefined, 'ar', 'de-AT', 'fr'])).toBe('de');
    expect(pickLocale(['ar', 'he'])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });

  it('offers the same languages as the website setting', () => {
    expect(WidgetSettingsSchema.shape.language.unwrap().options).toEqual(['auto', ...LOCALES]);
  });
});

describe('translations', () => {
  it('has every string in every language, none empty', () => {
    for (const locale of LOCALES) {
      const strings = TRANSLATIONS[locale];
      expect(Object.keys(strings).sort()).toEqual(Object.keys(TRANSLATIONS.en).sort());
      for (const [key, value] of Object.entries(strings)) {
        const text = typeof value === 'function' ? (value as (...args: unknown[]) => string)(2, '3 KB') : Array.isArray(value) ? value.join('') : value;
        expect([locale, key, typeof text === 'string' && text.trim().length > 0]).toEqual([locale, key, true]);
      }
      expect(strings.typing(null)).not.toContain('null');
      expect(strings.unread(3)).toContain('3');
      expect(strings.download('a.pdf', '2 MB')).toContain('a.pdf');
      expect(OPEN_LABEL[locale]).toBe(strings.open);
    }
  });

  it('writes sizes in each language’s units and numbers', () => {
    expect(formatSize(1_572_864, 'en', TRANSLATIONS.en)).toBe('1.5 MB');
    expect(formatSize(1_572_864, 'fr', TRANSLATIONS.fr)).toBe('1,5 Mo');
    expect(formatSize(1_572_864, 'de', TRANSLATIONS.de)).toBe('1,5 MB');
    expect(formatSize(200, 'en', TRANSLATIONS.en)).toBe('1 KB');
  });
});
