/**
 * Identifiers: `<prefix>_<26 chars>`, the Crockford base32 of a UUIDv7.
 * Time-sorted keys keep B-tree writes local. See docs/architecture/data-model.md.
 * Implemented here because node:crypto's randomUUIDv7 is unavailable in Workers.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIXES = {
  installation: 'inst',
  user: 'user',
  session: 'sess',
  workspace: 'work',
  member: 'mem',
  invitation: 'inv',
  website: 'site',
  contact: 'cont',
  visitor: 'vis',
  conversation: 'conv',
  message: 'msg',
  event: 'evt',
  attachment: 'att',
  tag: 'tag',
  pushSubscription: 'psub',
  emailDelivery: 'mail',
  automationRule: 'rule',
  automationRun: 'run',
  outbox: 'obx',
  failedJob: 'fjob',
  job: 'job',
  audit: 'aud',
  request: 'req',
  mutation: 'mut',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function uuidv7Bytes(now: number = Date.now()): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 48-bit big-endian millisecond timestamp. Division, not shifting: 32-bit bitwise operators would truncate it.
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytes;
}

/** 128 bits to 26 characters. The two spare bits lead, so string order matches numeric order. */
export function encodeBase32(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(uuidv7Bytes(now))}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${ID_PREFIXES[kind]}_[${ALPHABET}]{26}$`).test(value);
}

/**
 * The same ID for the same input, so that a retried create cannot make a second row. Not time-sorted, so
 * use it only where that matters less than the retry, and include the owner in `material`.
 */
export async function deterministicId(kind: IdKind, material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return `${ID_PREFIXES[kind]}_${encodeBase32(new Uint8Array(digest).slice(0, 16))}`;
}
