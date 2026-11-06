/**
 * `oc app variant`: makes `apps/mobile/variants/<id>/`, a white-label build of the iOS app. Everything it
 * writes is embedded in the app and readable by anyone, so it takes no secrets. The relay's APNs key stays
 * in the relay. See docs/ios-build/expo-and-white-label.md.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VariantOptions {
  id: string;
  appName: string;
  bundleId: string;
  /** An environment where `oc relay deploy` ran. Its URL and relay ID are read from there. */
  relayEnv?: string | undefined;
  relayUrl?: string | undefined;
  relayId?: string | undefined;
  noPush?: boolean;
  color?: string | undefined;
  icon?: string | undefined;
  splash?: string | undefined;
}

const ID = /^[a-z][a-z0-9-]{0,40}$/;
const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const RELAY_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Width, height, and whether it has an alpha channel, from the PNG header. */
export function pngInfo(bytes: Buffer): { width: number; height: number; alpha: boolean } | null {
  if (bytes.length < 26 || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const colorType = bytes[25]!;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

const httpsOrigin = (value: string, flag: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an https address`);
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username) throw new Error(`${flag} must be an https origin, with no path, such as https://chat.company.com`);
  return url.origin;
};

export function createVariantWriter(root: string, log: (line: string) => void = (line) => console.log(line)) {
  const variants = join(root, 'apps/mobile/variants');

  function relayFor(options: VariantOptions): { id: string; url: string } | null {
    const given = [options.relayEnv !== undefined, options.relayUrl !== undefined || options.relayId !== undefined, options.noPush === true].filter(Boolean).length;
    if (given !== 1) throw new Error('Choose one: --relay-env <env> (where you ran oc relay deploy), --relay-url with --relay-id, or --no-push');
    if (options.noPush) return null;
    if (options.relayEnv !== undefined) {
      const path = join(root, '.openchat', options.relayEnv, 'relay.json');
      if (!existsSync(path)) throw new Error(`No relay in .openchat/${options.relayEnv}. Run: pnpm oc relay deploy --env ${options.relayEnv}`);
      const relay = JSON.parse(readFileSync(path, 'utf8')) as { relayId: string; url?: string; bundleIds?: string[] };
      if (!relay.url) throw new Error(`The relay in .openchat/${options.relayEnv} has not been deployed yet`);
      if (relay.bundleIds?.length && !relay.bundleIds.includes(options.bundleId)) {
        log(`Note: the relay holds a key for ${relay.bundleIds.join(', ')}, not ${options.bundleId}. Run oc relay set-apns with --bundle-id ${options.bundleId}.`);
      }
      return { id: relay.relayId, url: relay.url };
    }
    if (!options.relayUrl || !options.relayId) throw new Error('--relay-url and --relay-id go together');
    if (!RELAY_ID.test(options.relayId)) throw new Error('--relay-id is lowercase letters, numbers, and hyphens, as oc relay deploy printed it');
    return { id: options.relayId, url: httpsOrigin(options.relayUrl, '--relay-url') };
  }

  function checkImage(path: string, flag: string, icon: boolean) {
    if (!existsSync(path)) throw new Error(`${flag}: ${path} does not exist`);
    const info = pngInfo(readFileSync(path));
    if (!info) throw new Error(`${flag} must be a PNG file`);
    if (icon && (info.width !== 1024 || info.height !== 1024)) throw new Error(`--icon must be 1024 by 1024 pixels, not ${info.width} by ${info.height}`);
    // The App Store refuses an app icon with transparency.
    if (icon && info.alpha) throw new Error('--icon must have no transparency. Export it without an alpha channel');
  }

  return {
    create(options: VariantOptions): string {
      if (!ID.test(options.id)) throw new Error('--id is lowercase letters, numbers, and hyphens, starting with a letter');
      if (options.id === 'official' || options.id === 'local') throw new Error(`"${options.id}" is reserved. Choose another --id`);
      const appName = options.appName.trim();
      if (appName.length === 0 || appName.length > 30 || !/[A-Za-z0-9]/.test(appName)) throw new Error('--name is 1 to 30 characters, with at least one letter or number');
      if (!BUNDLE_ID.test(options.bundleId)) throw new Error('--bundle-id looks like com.company.support');
      const color = options.color ?? '#2563eb';
      if (!COLOR.test(color)) throw new Error('--color is a colour such as #0f766e');
      const relay = relayFor(options);
      if (options.icon) checkImage(options.icon, '--icon', true);
      if (options.splash) checkImage(options.splash, '--splash', false);

      const directory = join(variants, options.id);
      if (existsSync(directory)) throw new Error(`apps/mobile/variants/${options.id} already exists. Edit its variant.json, or choose another --id`);
      mkdirSync(join(directory, 'assets'), { recursive: true });
      copyFileSync(options.icon ?? join(variants, 'official/assets/icon.png'), join(directory, 'assets/icon.png'));
      copyFileSync(options.splash ?? join(variants, 'official/assets/splash.png'), join(directory, 'assets/splash.png'));
      const variant = {
        id: options.id,
        appName,
        slug: options.id,
        urlScheme: options.id.replaceAll('-', ''),
        bundleIdentifier: options.bundleId,
        push: { enabled: relay !== null, allowedRelays: relay ? [relay] : [] },
        branding: { primaryColor: color },
        assets: { icon: 'assets/icon.png', splash: 'assets/splash.png' },
      };
      writeFileSync(join(directory, 'variant.json'), `${JSON.stringify(variant, null, 2)}\n`);

      log(`Made apps/mobile/variants/${options.id}`);
      if (!options.icon || !options.splash) log('It uses the OpenChat icon or splash for now. Replace them before you ship: --icon must be 1024 by 1024 with no transparency.');
      log(relay ? `Push goes only through ${relay.url} (relay ID ${relay.id}).` : 'Push is off. Messages still arrive when the app is open.');
      log(`\nNext, in apps/mobile:\n  APP_VARIANT=${options.id} fastlane ios refresh_profile\n  APP_VARIANT=${options.id} fastlane ios device`);
      return directory;
    },
  };
}
