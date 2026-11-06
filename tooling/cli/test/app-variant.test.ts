import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVariantWriter, pngInfo, type VariantOptions } from '../src/app-variant';

const officialDir = new URL('../../../apps/mobile/variants/official', import.meta.url).pathname;

/** Only the header, which is all the check reads. */
const png = (width: number, height: number, colorType = 2) => {
  const header = Buffer.alloc(26);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = colorType;
  return header;
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'oc-variant-'));
  cpSync(officialDir, join(root, 'apps/mobile/variants/official'), { recursive: true });
  mkdirSync(join(root, '.openchat/acme'), { recursive: true });
  writeFileSync(join(root, '.openchat/acme/relay.json'), JSON.stringify({ name: 'acme', relayId: 'acme', url: 'https://oc-acme-relay.acme.workers.dev', bundleIds: ['com.acme.support'] }));
  const lines: string[] = [];
  const writer = createVariantWriter(root, (line) => lines.push(line));
  const read = (id: string) => JSON.parse(readFileSync(join(root, 'apps/mobile/variants', id, 'variant.json'), 'utf8')) as Record<string, unknown>;
  const file = (name: string, bytes: Buffer) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };
  return { root, writer, read, file, lines };
}

const base: VariantOptions = { id: 'acme', appName: 'Acme Support', bundleId: 'com.acme.support', relayEnv: 'acme' };

describe('pngInfo', () => {
  it('reads the size and transparency, and refuses other files', () => {
    expect(pngInfo(png(1024, 1024))).toEqual({ width: 1024, height: 1024, alpha: false });
    expect(pngInfo(png(10, 20, 6))).toEqual({ width: 10, height: 20, alpha: true });
    expect(pngInfo(Buffer.from('GIF89a not a png at all, padding padding'))).toBeNull();
    expect(pngInfo(readFileSync(join(officialDir, 'assets/icon.png')))).toEqual({ width: 1024, height: 1024, alpha: false });
  });
});

describe('oc app variant', () => {
  it('makes a variant that sends push only through the relay it names', () => {
    const { writer, read, root, lines } = setup();
    writer.create({ ...base, color: '#0f766e' });
    expect(read('acme')).toEqual({
      id: 'acme',
      appName: 'Acme Support',
      slug: 'acme',
      urlScheme: 'acme',
      bundleIdentifier: 'com.acme.support',
      push: { enabled: true, allowedRelays: [{ id: 'acme', url: 'https://oc-acme-relay.acme.workers.dev' }] },
      branding: { primaryColor: '#0f766e' },
      assets: { icon: 'assets/icon.png', splash: 'assets/splash.png' },
    });
    expect(existsSync(join(root, 'apps/mobile/variants/acme/assets/icon.png'))).toBe(true);
    expect(lines.some((line) => line.includes('Replace them before you ship'))).toBe(true);
  });

  it('takes a relay by address, or none', () => {
    const { writer, read } = setup();
    writer.create({ ...base, id: 'by-url', relayEnv: undefined, relayUrl: 'https://push.acme.com', relayId: 'acme-push'});
    expect(read('by-url')).toMatchObject({ urlScheme: 'byurl', push: { enabled: true, allowedRelays: [{ id: 'acme-push', url: 'https://push.acme.com' }] } });
    writer.create({ ...base, id: 'quiet', relayEnv: undefined, noPush: true });
    expect(read('quiet').push).toEqual({ enabled: false, allowedRelays: [] });
  });

  it('copies images that are fit for the App Store, and refuses others', () => {
    const { writer, file, root } = setup();
    const icon = file('icon.png', png(1024, 1024));
    writer.create({ ...base, icon, splash: file('splash.png', png(400, 400, 6)) });
    expect(readFileSync(join(root, 'apps/mobile/variants/acme/assets/icon.png'))).toEqual(png(1024, 1024));
    expect(() => writer.create({ ...base, id: 'b', icon: file('small.png', png(512, 512)) })).toThrow(/1024 by 1024 pixels, not 512 by 512/);
    expect(() => writer.create({ ...base, id: 'b', icon: file('clear.png', png(1024, 1024, 6)) })).toThrow(/no transparency/);
    expect(() => writer.create({ ...base, id: 'b', icon: file('icon.jpg', Buffer.from('not a png, but long enough to have a header')) })).toThrow(/must be a PNG/);
    expect(existsSync(join(root, 'apps/mobile/variants/b'))).toBe(false);
  });

  it('checks everything before writing anything', () => {
    const { writer, root } = setup();
    const refuses = (options: Partial<VariantOptions>, message: RegExp) => expect(() => writer.create({ ...base, ...options })).toThrow(message);
    refuses({ id: 'official' }, /reserved/);
    refuses({ id: 'Acme' }, /--id/);
    refuses({ bundleId: 'support' }, /--bundle-id/);
    refuses({ color: 'teal' }, /--color/);
    refuses({ relayEnv: undefined }, /Choose one/);
    refuses({ noPush: true }, /Choose one/);
    refuses({ relayEnv: 'nowhere' }, /oc relay deploy --env nowhere/);
    refuses({ relayEnv: undefined, relayUrl: 'http://push.acme.com', relayId: 'acme' }, /https origin/);
    refuses({ relayEnv: undefined, relayUrl: 'https://push.acme.com/v1', relayId: 'acme' }, /no path/);
    expect(existsSync(join(root, 'apps/mobile/variants/acme'))).toBe(false);
    writer.create(base);
    refuses({}, /already exists/);
  });

  it('says when the relay holds a key for another app', () => {
    const { writer, lines } = setup();
    writer.create({ ...base, bundleId: 'com.acme.other' });
    expect(lines.some((line) => line.includes('Run oc relay set-apns with --bundle-id com.acme.other'))).toBe(true);
  });
});
