import { describe, expect, it } from 'vitest';
import { parseSecurityContacts, PROJECT_SECURITY_URL, securityTxt } from './index';

const base = { canonical: 'https://chat.example.com/.well-known/security.txt', now: new Date('2026-11-13T15:30:00Z'), subject: 'installation' as const };

describe('security.txt', () => {
  it('names the operator, points to the project, and expires 30 days ahead, at midnight UTC', () => {
    expect(securityTxt({ ...base, contact: 'mailto:security@example.com, https://example.com/report', policy: 'https://example.com/disclosure' })).toBe(
      [
        '# The operator of this OpenChat installation. Report problems with this service here.',
        `# Vulnerabilities in the OpenChat software itself: ${PROJECT_SECURITY_URL}`,
        'Contact: mailto:security@example.com',
        'Contact: https://example.com/report',
        'Expires: 2026-12-13T00:00:00Z',
        'Policy: https://example.com/disclosure',
        'Preferred-Languages: en',
        'Canonical: https://chat.example.com/.well-known/security.txt',
        '',
      ].join('\n'),
    );
  });

  it('says relay for a relay, and leaves out a policy that is not https', () => {
    const text = securityTxt({ ...base, subject: 'relay', contact: 'mailto:a@example.org', policy: 'http://example.org/p' })!;
    expect(text).toContain('notification relay');
    expect(text).not.toContain('Policy:');
  });

  it('is absent without a valid contact', () => {
    for (const contact of [undefined, '', ' , ', 'security@example.com', 'http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'mailto:a@example.com\nPolicy: https://evil.example', 'mailto:a@example.com,ftp://x']) {
      expect(securityTxt({ ...base, contact })).toBeNull();
    }
  });

  it('accepts at most five contacts', () => {
    expect(parseSecurityContacts(Array.from({ length: 5 }, (_, i) => `mailto:s${i}@example.com`).join(','))).toHaveLength(5);
    expect(parseSecurityContacts(Array.from({ length: 6 }, (_, i) => `mailto:s${i}@example.com`).join(','))).toBeNull();
  });
});
