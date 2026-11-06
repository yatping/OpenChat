import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { variantProblems } from '../config/variant';

const variants = join(__dirname, '../variants');
const official = JSON.parse(readFileSync(join(variants, 'official/variant.json'), 'utf8')) as Record<string, unknown>;

describe('variantProblems', () => {
  it('accepts every committed variant', () => {
    for (const id of readdirSync(variants).filter((name) => name !== 'local')) {
      expect(variantProblems(JSON.parse(readFileSync(join(variants, id, 'variant.json'), 'utf8')), id)).toEqual([]);
    }
  });

  it('refuses a field it does not know, so that nothing private is added by mistake', () => {
    expect(variantProblems({ ...official, apnsKey: 'x' }, 'official')).toContain('Unknown field "apnsKey". A variant holds only public values');
  });

  it('refuses relays that are not plain https origins', () => {
    const withRelay = (url: string) => variantProblems({ ...official, push: { enabled: true, allowedRelays: [{ id: 'acme', url }] } }, 'official');
    expect(withRelay('https://relay.acme.com')).toEqual([]);
    for (const url of ['http://relay.acme.com', 'https://relay.acme.com/', 'https://relay.acme.com/v1', 'relay.acme.com']) expect(withRelay(url).length).toBe(1);
  });

  it('needs a relay for push, and names every other problem', () => {
    expect(variantProblems({ ...official, push: { enabled: true, allowedRelays: [] } }, 'official')).toEqual(['push.enabled needs at least one relay in allowedRelays']);
    expect(variantProblems({ ...official, push: { enabled: false, allowedRelays: [] } }, 'official')).toEqual([]);
    const problems = variantProblems({ ...official, id: 'acme', bundleIdentifier: 'support', branding: { primaryColor: 'blue' }, assets: { icon: '../icon.png', splash: 'assets/splash.png' } }, 'official');
    expect(problems).toHaveLength(4);
  });
});
