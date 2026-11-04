import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpoConfig } from 'expo/config';
import type { AppVariant } from './config/variant';

/** Reads `variants/<id>/variant.json`. A white-label build adds a directory, and sets APP_VARIANT. */
function loadVariant(id: string): AppVariant {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid app variant: ${id}`);
  const directory = join(__dirname, 'variants', id);
  const variant = JSON.parse(readFileSync(join(directory, 'variant.json'), 'utf8')) as AppVariant;
  return { ...variant, id, assets: { icon: join(directory, variant.assets.icon), splash: join(directory, variant.assets.splash) } };
}

const variant = loadVariant(process.env.APP_VARIANT ?? 'official');
const profile = process.env.APP_PROFILE ?? 'development';

// Nothing secret belongs in `extra`: it is embedded in the app, and anyone can read it.
export default (): ExpoConfig => ({
  name: variant.appName,
  slug: variant.slug,
  version: '0.1.0',
  scheme: variant.urlScheme,
  icon: variant.assets.icon,
  platforms: ['ios'],
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: variant.bundleIdentifier,
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
  },
  plugins: ['expo-router', 'expo-secure-store', 'expo-sqlite', ['expo-splash-screen', { image: variant.assets.splash, backgroundColor: variant.branding.primaryColor, imageWidth: 200 }]],
  experiments: { typedRoutes: false },
  extra: {
    variant: variant.id,
    push: {
      enabled: variant.push.enabled,
      environment: profile === 'development' ? 'sandbox' : 'production',
      allowedRelays: variant.push.allowedRelays,
    },
    lockedInstallationUrl: variant.lockedInstallationUrl ?? null,
    branding: variant.branding,
  },
});
