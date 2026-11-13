import { preference } from './app-context';
import { getLocale, LANGUAGE_PREFERENCE, t } from './i18n';
import { LANGUAGES } from './i18n/locales';

/** Choosing a language keeps it in this browser, and reloads, so that everything on the page changes at once. */
export function LanguagePicker({ className = '' }: { className?: string }) {
  return (
    <select
      className={`field w-auto ${className}`}
      aria-label={t('language')}
      value={getLocale()}
      onChange={(event) => {
        preference.set(LANGUAGE_PREFERENCE, event.target.value);
        window.location.reload();
      }}
    >
      {LANGUAGES.map(([code, name]) => (
        <option key={code} value={code} lang={code}>
          {name}
        </option>
      ))}
    </select>
  );
}
