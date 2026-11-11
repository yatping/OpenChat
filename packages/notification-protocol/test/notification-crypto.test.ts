// Runs in workerd and in Node, because the installation encrypts in a Worker and tools may run in Node.
import { describe, expect, it } from 'vitest';
import {
  fitNotificationContent,
  fromBase64Url,
  generateX25519KeyPair,
  hpkeOpenBase,
  hpkeSealBase,
  NOTIFICATION_PLAINTEXT_BYTES,
  NOTIFICATION_SEALED_LENGTH,
  type NotificationBinding,
  openNotification,
  sealNotification,
  toBase64Url,
} from '../src/index';

const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// RFC 9180, Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const A11 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
};

const binding: NotificationBinding = { installationId: 'inst_A', workspaceId: 'wks_B', notificationId: 'ntf_C', subscriptionId: 'sub_D' };
const content = { title: 'Acme support', sender: 'Jane Doe', text: 'Hi, is my order on its way?' };

describe('HPKE against RFC 9180 A.1.1', () => {
  it('seals to the published ciphertext', async () => {
    const sealed = await hpkeSealBase(hex(A11.pkRm), hex(A11.info), hex(A11.aad), hex(A11.pt), { privateKey: hex(A11.skEm), publicKey: hex(A11.pkEm) });
    expect(toHex(sealed.enc)).toBe(A11.pkEm);
    expect(toHex(sealed.ciphertext)).toBe(A11.ct);
  });

  it('opens the published ciphertext', async () => {
    const opened = await hpkeOpenBase({ privateKey: hex(A11.skRm), publicKey: hex(A11.pkRm) }, hex(A11.pkEm), hex(A11.info), hex(A11.aad), hex(A11.ct));
    expect(toHex(opened)).toBe(A11.pt);
  });

  it('refuses a changed ciphertext or associated data', async () => {
    const recipient = { privateKey: hex(A11.skRm), publicKey: hex(A11.pkRm) };
    const ct = hex(A11.ct);
    ct[0]! ^= 1;
    await expect(hpkeOpenBase(recipient, hex(A11.pkEm), hex(A11.info), hex(A11.aad), ct)).rejects.toThrow();
    await expect(hpkeOpenBase(recipient, hex(A11.pkEm), hex(A11.info), hex('436f756e742d31'), hex(A11.ct))).rejects.toThrow();
  });

  it('refuses a low-order public key', async () => {
    await expect(hpkeSealBase(new Uint8Array(32), hex(A11.info), hex(A11.aad), hex(A11.pt))).rejects.toThrow();
  });
});

describe('sealed notifications', () => {
  it('round-trips, at a fixed size whatever the length', async () => {
    const phone = await generateX25519KeyPair();
    const key = toBase64Url(phone.publicKey);
    const short = await sealNotification(key, { ...content, text: 'ok' }, binding);
    const long = await sealNotification(key, { ...content, text: 'x'.repeat(500) }, binding);
    expect(short).toHaveLength(NOTIFICATION_SEALED_LENGTH);
    expect(long).toHaveLength(NOTIFICATION_SEALED_LENGTH);
    expect(await openNotification(phone, short, binding)).toEqual({ v: 1, ...content, text: 'ok' });
  });

  it('uses a fresh ephemeral key every time', async () => {
    const phone = await generateX25519KeyPair();
    const key = toBase64Url(phone.publicKey);
    expect(await sealNotification(key, content, binding)).not.toBe(await sealNotification(key, content, binding));
  });

  it.each(['installationId', 'workspaceId', 'notificationId', 'subscriptionId'] as const)('cannot be moved to another %s', async (field) => {
    const phone = await generateX25519KeyPair();
    const sealed = await sealNotification(toBase64Url(phone.publicKey), content, binding);
    await expect(openNotification(phone, sealed, { ...binding, [field]: 'other' })).rejects.toThrow();
  });

  it('cannot be opened by another phone', async () => {
    const phone = await generateX25519KeyPair();
    const other = await generateX25519KeyPair();
    const sealed = await sealNotification(toBase64Url(phone.publicKey), content, binding);
    await expect(openNotification(other, sealed, binding)).rejects.toThrow();
  });

  it('refuses a tampered or resized ciphertext', async () => {
    const phone = await generateX25519KeyPair();
    const sealed = await sealNotification(toBase64Url(phone.publicKey), content, binding);
    const bytes = fromBase64Url(sealed);
    bytes[100]! ^= 1;
    await expect(openNotification(phone, toBase64Url(bytes), binding)).rejects.toThrow();
    await expect(openNotification(phone, sealed.slice(0, -4), binding)).rejects.toThrow();
  });

  it('refuses a malformed key or binding', async () => {
    await expect(sealNotification('short', content, binding)).rejects.toThrow();
    const phone = await generateX25519KeyPair();
    await expect(sealNotification(toBase64Url(phone.publicKey), content, { ...binding, notificationId: 'a\nb' })).rejects.toThrow();
  });
});

describe('fitting content', () => {
  const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value)).length;

  it('applies the character limits, with an ellipsis', () => {
    const fitted = fitNotificationContent({ title: 't'.repeat(60), sender: 's'.repeat(60), text: 'x'.repeat(60) });
    expect(Array.from(fitted.title)).toHaveLength(40);
    expect(fitted.title.endsWith('…')).toBe(true);
    expect(fitted.text).toBe('x'.repeat(60));
  });

  it('shortens text first, to fit the padded size', () => {
    const fitted = fitNotificationContent({ title: 'Acme', sender: 'Jane', text: 'é'.repeat(150) });
    expect(fitted.title).toBe('Acme');
    expect(fitted.sender).toBe('Jane');
    expect(bytes(fitted)).toBeLessThanOrEqual(NOTIFICATION_PLAINTEXT_BYTES - 2);
    expect(fitted.text.endsWith('…')).toBe(true);
  });

  it('fits four-byte characters and never splits one', () => {
    const fitted = fitNotificationContent({ title: '😀'.repeat(40), sender: '😀'.repeat(40), text: '😀'.repeat(150) });
    expect(bytes(fitted)).toBeLessThanOrEqual(NOTIFICATION_PLAINTEXT_BYTES - 2);
    for (const value of [fitted.title, fitted.sender, fitted.text]) expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('turns line and control characters into spaces, and removes bidi overrides', () => {
    expect(fitNotificationContent({ title: 'A‮cme', sender: 'Jane\nDoe', text: 'one\r\n\ttwo three' })).toEqual({ v: 1, title: 'Acme', sender: 'Jane Doe', text: 'one two three' });
  });
});
