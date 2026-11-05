/**
 * Everything the app learns about an installation before trusting it enough to show a login form. The address
 * and the answer both come from whoever the user typed in, so neither is assumed to be well formed.
 */
import type { DiscoveryResponse } from '@openchat/api-client';

const API_VERSION = 'v1';
/** The oldest `api.minor` this app can use. Raise it when the app starts to depend on something newer. */
const MIN_API_MINOR = 0;
const DISCOVERY_TIMEOUT_MS = 15_000;

export type UrlResult = { ok: true; baseUrl: string } | { ok: false; reason: 'invalid' | 'insecure' };

/** Reduces what someone typed to an origin. Plain HTTP is only for a development server on this machine. */
export function normalizeInstallationUrl(input: string, options: { allowLocalHttp: boolean }): UrlResult {
  const text = input.trim();
  if (!text) return { ok: false, reason: 'invalid' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(withScheme);
  if (!match) return { ok: false, reason: 'invalid' };
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  if ((match[3] ?? '/').replace(/\/+$/, '') !== '' || host.includes('@') || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return { ok: false, reason: 'invalid' };
  const hostname = host.split(':')[0]!;
  if (scheme === 'https') return { ok: true, baseUrl: `https://${host}` };
  if (scheme === 'http') return options.allowLocalHttp && (hostname === 'localhost' || hostname === '127.0.0.1') ? { ok: true, baseUrl: `http://${host}` } : { ok: false, reason: 'insecure' };
  return { ok: false, reason: 'invalid' };
}

export type Compatibility = 'compatible' | 'update_app' | 'update_installation';

export function checkCompatibility(discovery: Pick<DiscoveryResponse, 'api'>): Compatibility {
  const { versions, minor } = discovery.api;
  if (!versions.includes(API_VERSION)) {
    const newest = Math.max(0, ...versions.map((version) => Number(/^v(\d+)$/.exec(version)?.[1] ?? 0)));
    return newest > Number(API_VERSION.slice(1)) ? 'update_app' : 'update_installation';
  }
  return minor < MIN_API_MINOR ? 'update_installation' : 'compatible';
}

function isDiscovery(value: unknown): value is DiscoveryResponse {
  const body = value as Partial<DiscoveryResponse> | null;
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof body.installationId === 'string' &&
    typeof body.name === 'string' &&
    Array.isArray(body.api?.versions) &&
    body.api.versions.every((version) => typeof version === 'string') &&
    typeof body.api.minor === 'number'
  );
}

export type DiscoveryError = 'unreachable' | 'not_openchat';

export async function fetchDiscovery(baseUrl: string, fetcher: typeof globalThis.fetch): Promise<{ ok: true; discovery: DiscoveryResponse } | { ok: false; reason: DiscoveryError }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DISCOVERY_TIMEOUT_MS);
    });
    const response = await Promise.race([fetcher(`${baseUrl}/.well-known/openchat.json`, { headers: { accept: 'application/json' } }), timeout]);
    if (!response.ok) return { ok: false, reason: 'not_openchat' };
    const body: unknown = await Promise.race([response.json(), timeout]).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'timeout') throw error;
      return null;
    });
    return isDiscovery(body) ? { ok: true, discovery: body } : { ok: false, reason: 'not_openchat' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
