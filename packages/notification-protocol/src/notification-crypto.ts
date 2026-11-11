/**
 * Encrypted notifications (ADR-0017). The installation encrypts each notification for one phone; the relay and Apple
 * carry ciphertext they cannot read; the phone's notification extension decrypts it.
 *
 * HPKE (RFC 9180), base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. Built from WebCrypto primitives
 * so that it runs in Workers and Node with no library, and checked against the RFC's test vectors. The iOS extension
 * repeats the same steps with CryptoKit, so any change here is a protocol change.
 */
import { fromBase64Url, toBase64Url } from './signing';

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;
const N_SECRET = 32;
const N_ENC = 32;
const N_PK = 32;
const N_SK = 32;
const N_H = 32;
const N_K = 16;
const N_N = 12;
const N_T = 16;

function alloc(length: number): Bytes {
  return new Uint8Array(new ArrayBuffer(length));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = alloc(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function i2osp(value: number, length: number): Bytes {
  const out = alloc(length);
  for (let i = length - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

const EMPTY = alloc(0);
const VERSION_LABEL = encoder.encode('HPKE-v1');
const KEM_SUITE = concat(encoder.encode('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE = concat(encoder.encode('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
/** PKCS #8 wrapping of a raw X25519 private key (RFC 8410). WebCrypto cannot import a raw private key. */
const PKCS8_X25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  // An empty HMAC key equals a key of zeros, and some runtimes refuse a zero-length key.
  const imported = await crypto.subtle.importKey('raw', key.length > 0 ? concat(key) : alloc(N_H), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, concat(data)));
}

async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const out = alloc(length);
  let block: Bytes = EMPTY;
  for (let i = 1, offset = 0; offset < length; i++) {
    block = await hmac(prk, concat(block, info, Uint8Array.of(i)));
    out.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
    offset += block.length;
  }
  return out;
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
  return hmac(salt, concat(VERSION_LABEL, suite, encoder.encode(label), ikm));
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Promise<Bytes> {
  return expand(prk, concat(i2osp(length, 2), VERSION_LABEL, suite, encoder.encode(label), info), length);
}

export interface X25519KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function importPrivate(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== N_SK) throw new RangeError('An X25519 private key is 32 bytes');
  return crypto.subtle.importKey('pkcs8', concat(PKCS8_X25519_PREFIX, raw), { name: 'X25519' }, false, ['deriveBits']);
}

function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== N_PK) throw new RangeError('An X25519 public key is 32 bytes');
  return crypto.subtle.importKey('raw', concat(raw), { name: 'X25519' }, true, []);
}

/** WebCrypto refuses an all-zero result, which is the check RFC 9180 asks for against low-order points. */
async function dh(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Bytes> {
  // Workers' types spell the `public` member differently from the runtime and the standard, so the shape is asserted.
  const params = { name: 'X25519', public: await importPublic(publicKey) } as unknown as Parameters<SubtleCrypto['deriveBits']>[0];
  const bits = await crypto.subtle.deriveBits(params, await importPrivate(privateKey), 256);
  return new Uint8Array(bits);
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { privateKey: pkcs8.slice(pkcs8.length - N_SK), publicKey };
}

async function extractAndExpand(sharedDh: Uint8Array, kemContext: Uint8Array): Promise<Bytes> {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', sharedDh);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, N_SECRET);
}

async function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<{ key: CryptoKey; nonce: Bytes }> {
  const pskIdHash = await labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  const rawKey = await labeledExpand(HPKE_SUITE, secret, 'key', context, N_K);
  const nonce = await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_N);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, nonce };
}

/**
 * Single-shot HPKE base-mode seal, sequence number 0. `ephemeral` exists for the RFC test vectors only: a reused
 * ephemeral key would reuse the AEAD key and nonce.
 */
export async function hpkeSealBase(recipientPublicKey: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, ephemeral?: X25519KeyPair): Promise<{ enc: Bytes; ciphertext: Bytes }> {
  const pair = ephemeral ?? (await generateX25519KeyPair());
  const enc = concat(pair.publicKey);
  const sharedSecret = await extractAndExpand(await dh(pair.privateKey, recipientPublicKey), concat(enc, recipientPublicKey));
  const { key, nonce } = await keySchedule(sharedSecret, info);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(aad), tagLength: N_T * 8 }, key, concat(plaintext));
  return { enc, ciphertext: new Uint8Array(sealed) };
}

/** Throws if the ciphertext, the associated data, or the key does not match. */
export async function hpkeOpenBase(recipient: X25519KeyPair, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
  if (enc.length !== N_ENC) throw new RangeError('enc is 32 bytes');
  const sharedSecret = await extractAndExpand(await dh(recipient.privateKey, enc), concat(enc, recipient.publicKey));
  const { key, nonce } = await keySchedule(sharedSecret, info);
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: concat(aad), tagLength: N_T * 8 }, key, concat(ciphertext));
  return new Uint8Array(opened);
}

// ---------------------------------------------------------------------------------------------------------------
// The notification format on top of HPKE.

/** Fixed, so the relay cannot tell a long message from a short one. */
export const NOTIFICATION_PLAINTEXT_BYTES = 256;
export const NOTIFICATION_SEALED_BYTES = N_ENC + NOTIFICATION_PLAINTEXT_BYTES + N_T;
/** The base64url length of every sealed notification. Schemas check it exactly. */
export const NOTIFICATION_SEALED_LENGTH = Math.ceil((NOTIFICATION_SEALED_BYTES * 4) / 3);
export const NOTIFICATION_SEALED_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${NOTIFICATION_SEALED_LENGTH}}$`);
/** A phone's public key for one subscription: 32 bytes, base64url. */
export const PREVIEW_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const NOTIFICATION_LIMITS = { title: 40, sender: 40, text: 150 } as const;

const INFO = encoder.encode('OpenChat notification v1');
const LENGTH_PREFIX = 2;
const ELLIPSIS = '…';

export interface NotificationContent {
  v: 1;
  /** The workspace name. */
  title: string;
  /** The contact's display name, "Visitor", or empty for events that have no sender. */
  sender: string;
  text: string;
}

/** Everything the ciphertext is bound to. The relay cannot move it to another notification, person, or phone. */
export interface NotificationBinding {
  installationId: string;
  workspaceId: string;
  notificationId: string;
  subscriptionId: string;
}

export function notificationAad(binding: NotificationBinding): Bytes {
  const parts = [binding.installationId, binding.workspaceId, binding.notificationId, binding.subscriptionId];
  if (parts.some((part) => part.length === 0 || part.includes('\n'))) throw new RangeError('Binding IDs must be non-empty and on one line');
  return concat(encoder.encode(['OCN1', ...parts].join('\n')));
}

/** Removes anything that could disguise the text: control and line characters become spaces, bidi overrides go. */
function clean(value: string): string {
  return value
    .replace(/[‪-‮⁦-⁩‎‏]/g, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(chars: string[], length: number): string {
  return length >= chars.length ? chars.join('') : `${chars.slice(0, Math.max(0, length - 1)).join('')}${ELLIPSIS}`;
}

/**
 * Applies the character limits, then shortens the text, then the sender, then the title, until the JSON fits the
 * padded size. Cuts fall between code points, never inside one.
 */
export function fitNotificationContent(input: { title: string; sender: string; text: string }): NotificationContent {
  const fields = {
    title: Array.from(clean(input.title)),
    sender: Array.from(clean(input.sender)),
    text: Array.from(clean(input.text)),
  };
  const lengths = {
    title: Math.min(fields.title.length, NOTIFICATION_LIMITS.title),
    sender: Math.min(fields.sender.length, NOTIFICATION_LIMITS.sender),
    text: Math.min(fields.text.length, NOTIFICATION_LIMITS.text),
  };
  const build = (): NotificationContent => ({ v: 1, title: cut(fields.title, lengths.title), sender: cut(fields.sender, lengths.sender), text: cut(fields.text, lengths.text) });
  let content = build();
  for (const field of ['text', 'sender', 'title'] as const) {
    while (encoder.encode(JSON.stringify(content)).length > NOTIFICATION_PLAINTEXT_BYTES - LENGTH_PREFIX && lengths[field] > 0) {
      lengths[field] -= 1;
      content = build();
    }
  }
  return content;
}

function pad(content: NotificationContent): Bytes {
  const json = encoder.encode(JSON.stringify(content));
  if (json.length > NOTIFICATION_PLAINTEXT_BYTES - LENGTH_PREFIX) throw new RangeError('Notification content does not fit');
  const out = alloc(NOTIFICATION_PLAINTEXT_BYTES);
  out.set(i2osp(json.length, LENGTH_PREFIX));
  out.set(json, LENGTH_PREFIX);
  return out;
}

function unpad(padded: Uint8Array): NotificationContent {
  if (padded.length !== NOTIFICATION_PLAINTEXT_BYTES) throw new RangeError('Wrong padded size');
  const length = (padded[0]! << 8) | padded[1]!;
  if (length > NOTIFICATION_PLAINTEXT_BYTES - LENGTH_PREFIX || padded.subarray(LENGTH_PREFIX + length).some((byte) => byte !== 0)) throw new RangeError('Bad padding');
  const value: unknown = JSON.parse(decoder.decode(padded.subarray(LENGTH_PREFIX, LENGTH_PREFIX + length)));
  if (typeof value !== 'object' || value === null) throw new RangeError('Bad content');
  const { v, title, sender, text } = value as Record<string, unknown>;
  if (v !== 1 || typeof title !== 'string' || typeof sender !== 'string' || typeof text !== 'string') throw new RangeError('Bad content');
  return { v, title, sender, text };
}

export function parsePreviewKey(value: string): Bytes {
  if (!PREVIEW_KEY_PATTERN.test(value)) throw new RangeError('Invalid preview key');
  const key = fromBase64Url(value);
  if (key.length !== N_PK) throw new RangeError('Invalid preview key');
  return key;
}

/** Encrypts one notification for one subscription's phone. Returns `enc || ciphertext`, base64url. */
export async function sealNotification(previewKey: string, content: { title: string; sender: string; text: string }, binding: NotificationBinding): Promise<string> {
  const { enc, ciphertext } = await hpkeSealBase(parsePreviewKey(previewKey), INFO, notificationAad(binding), pad(fitNotificationContent(content)));
  return toBase64Url(concat(enc, ciphertext));
}

/** The phone's side, for tests and tools. The iOS extension implements the same in Swift. */
export async function openNotification(recipient: X25519KeyPair, sealed: string, binding: NotificationBinding): Promise<NotificationContent> {
  if (!NOTIFICATION_SEALED_PATTERN.test(sealed)) throw new RangeError('Wrong sealed size');
  const bytes = fromBase64Url(sealed);
  const padded = await hpkeOpenBase(recipient, bytes.subarray(0, N_ENC), INFO, notificationAad(binding), bytes.subarray(N_ENC));
  return unpad(padded);
}
