/**
 * `/.well-known/security.txt`, per RFC 9116, for an installation and for a relay. Each names its operator,
 * who runs it, and points to the project for vulnerabilities in OpenChat itself. See SECURITY.md.
 */

/** Where vulnerabilities in OpenChat's own code are reported. */
export const PROJECT_SECURITY_URL = 'https://github.com/yatping/OpenChat/security';

/** How far ahead `Expires` is. It is written on each request, so it never lapses while the operator's settings stand. */
export const SECURITY_TXT_DAYS = 30;

/**
 * Splits and checks the operator's contacts: `mailto:` addresses and `https:` URLs, separated by commas.
 * Returns null if any is not one of those, so that a mistake is refused rather than published.
 */
export function parseSecurityContacts(value: string | undefined): string[] | null {
  const contacts = (value ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (contacts.length === 0 || contacts.length > 5) return null;
  return contacts.every(isContact) ? contacts : null;
}

function isContact(value: string): boolean {
  if (/[\s\r\n]/.test(value)) return false;
  if (value.startsWith('mailto:')) return /^mailto:[^@/?#]+@[^@/?#]+\.[^@/?#]+$/.test(value);
  return isHttpsUrl(value);
}

export function isHttpsUrl(value: string): boolean {
  if (/[\s\r\n]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export interface SecurityTxtOptions {
  /** As configured, unparsed. Without a valid contact there is no file. */
  contact: string | undefined;
  policy?: string | undefined;
  /** The URL this file is served at. */
  canonical: string;
  now: Date;
  /** Who runs what this file is about, for the comment at the top. */
  subject: 'installation' | 'relay';
}

/** The file's text, or null when the operator has not set a valid contact. */
export function securityTxt(options: SecurityTxtOptions): string | null {
  const contacts = parseSecurityContacts(options.contact);
  if (!contacts) return null;
  const expires = new Date(Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate() + SECURITY_TXT_DAYS));
  const lines = [
    `# The operator of this OpenChat ${options.subject === 'relay' ? 'notification relay' : 'installation'}. Report problems with this service here.`,
    `# Vulnerabilities in the OpenChat software itself: ${PROJECT_SECURITY_URL}`,
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${expires.toISOString().replace('.000Z', 'Z')}`,
    ...(options.policy && isHttpsUrl(options.policy) ? [`Policy: ${options.policy}`] : []),
    'Preferred-Languages: en',
    `Canonical: ${options.canonical}`,
  ];
  return `${lines.join('\n')}\n`;
}
