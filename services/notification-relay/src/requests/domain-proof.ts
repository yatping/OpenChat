/**
 * Proves control of an address by reading its discovery document. The address comes from an unauthenticated
 * caller, so this is a server-side request to wherever they choose: HTTPS, port 443, no redirects, 64 KB, 5 seconds,
 * and no IP addresses or single-label names. Failures all look alike, so this cannot be used to probe networks.
 */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

export function normalizeBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  const host = url.hostname;
  // new URL() already rewrites other spellings of an IPv4 address, such as hex, to dotted decimal.
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  return url.origin;
}

async function readLimited(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function documentProvesControl(fetcher: typeof fetch, baseUrl: string, expected: { installationId: string; keyId: string; publicKey: string }): Promise<boolean> {
  try {
    const response = await fetcher(`${baseUrl}/.well-known/openchat.json`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (response.status !== 200) return false;
    const text = await readLimited(response);
    if (text === null) return false;
    const document = JSON.parse(text) as { installationId?: unknown; relay?: { publicKeys?: { id?: unknown; alg?: unknown; key?: unknown }[] } | null };
    if (document.installationId !== expected.installationId || !Array.isArray(document.relay?.publicKeys)) return false;
    return document.relay.publicKeys.some((key) => key?.id === expected.keyId && key.alg === 'Ed25519' && key.key === expected.publicKey);
  } catch {
    return false;
  }
}
