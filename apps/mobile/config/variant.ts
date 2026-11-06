/** One build of the app. Every value here ends up readable inside the app, so nothing here can be secret. */
export interface AppVariant {
  id: string;
  appName: string;
  slug: string;
  urlScheme: string;
  bundleIdentifier: string;
  lockedInstallationUrl?: string;
  push: {
    enabled: boolean;
    allowedRelays: { id: string; url: string }[];
  };
  branding: { primaryColor: string };
  assets: { icon: string; splash: string };
}

const KEYS = ['id', 'appName', 'slug', 'urlScheme', 'bundleIdentifier', 'lockedInstallationUrl', 'push', 'branding', 'assets'];
export const VARIANT_ID = /^[a-z][a-z0-9-]{0,40}$/;
export const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ASSET = /^assets\/[A-Za-z0-9._-]+\.png$/;

const isHttpsOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !value.endsWith('/');
  } catch {
    return false;
  }
};

/**
 * Checks a variant.json before a build uses it. Unknown keys are refused, so that nothing, a key or a
 * password included, is added to the app by mistake. Returns every problem found, or none.
 */
export function variantProblems(value: unknown, directoryName: string): string[] {
  if (typeof value !== 'object' || value === null) return ['variant.json must be an object'];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(v)) if (!KEYS.includes(key)) problems.push(`Unknown field "${key}". A variant holds only public values`);
  if (v.id !== directoryName) problems.push(`id must be "${directoryName}", the name of its directory`);
  if (typeof v.id !== 'string' || !VARIANT_ID.test(v.id)) problems.push('id must be lowercase letters, numbers, and hyphens');
  if (typeof v.appName !== 'string' || v.appName.trim().length === 0 || v.appName.length > 30) problems.push('appName must be 1 to 30 characters');
  else if (!/[A-Za-z0-9]/.test(v.appName)) problems.push('appName needs at least one letter or number, which names the Xcode project');
  if (typeof v.slug !== 'string' || !VARIANT_ID.test(v.slug)) problems.push('slug must be lowercase letters, numbers, and hyphens');
  if (typeof v.urlScheme !== 'string' || !SCHEME.test(v.urlScheme)) problems.push('urlScheme must start with a letter, then letters, numbers, +, -, or .');
  if (typeof v.bundleIdentifier !== 'string' || !BUNDLE_ID.test(v.bundleIdentifier)) problems.push('bundleIdentifier looks like com.company.support');
  if (v.lockedInstallationUrl !== undefined && !isHttpsOrigin(v.lockedInstallationUrl)) problems.push('lockedInstallationUrl must be an https origin, such as https://chat.company.com');

  const push = v.push as Record<string, unknown> | undefined;
  if (typeof push !== 'object' || push === null || typeof push.enabled !== 'boolean' || !Array.isArray(push.allowedRelays)) {
    problems.push('push must be { "enabled": true or false, "allowedRelays": [...] }');
  } else {
    if (push.enabled && push.allowedRelays.length === 0) problems.push('push.enabled needs at least one relay in allowedRelays');
    for (const relay of push.allowedRelays as Record<string, unknown>[]) {
      if (typeof relay?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(relay.id)) problems.push('Each relay needs an id, as `oc relay deploy` printed it');
      if (!isHttpsOrigin(relay?.url)) problems.push(`Relay URL ${String(relay?.url)} must be an https origin, with no path`);
    }
  }
  const branding = v.branding as Record<string, unknown> | undefined;
  if (typeof branding?.primaryColor !== 'string' || !COLOR.test(branding.primaryColor)) problems.push('branding.primaryColor must be a colour such as #2563eb');
  const assets = v.assets as Record<string, unknown> | undefined;
  for (const name of ['icon', 'splash']) {
    const path = assets?.[name];
    if (typeof path !== 'string' || !ASSET.test(path)) problems.push(`assets.${name} must be a PNG file in the variant's assets directory`);
  }
  return problems;
}
