import { describe, expect, it, vi } from 'vitest';
import { EmailSendError, formatSender, ResendEmailProvider, type EmailMessage } from './index';

const message: EmailMessage = {
  to: 'person@example.com',
  from: { name: 'Acme Support', email: 'no-reply@example.com' },
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  idempotencyKey: 'key-1',
};

const answering = (response: Response | Error) => vi.fn<typeof fetch>(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));

describe('ResendEmailProvider', () => {
  it('sends the documented request', async () => {
    const fetcher = answering(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    expect(await new ResendEmailProvider('test-key', fetcher).send(message)).toEqual({ messageId: 'abc' });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'idempotency-key': 'key-1', 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: '"Acme Support" <no-reply@example.com>',
      to: ['person@example.com'],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
    });
  });

  it('sends no idempotency header without a key', async () => {
    const fetcher = answering(new Response('{}', { status: 200 }));
    const withoutKey = { ...message };
    delete withoutKey.idempotencyKey;
    await new ResendEmailProvider('test-key', fetcher).send(withoutKey);
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('idempotency-key');
  });

  it.each([401, 403, 409, 422, 429, 500])('throws on %i, keeping only the status', async (status) => {
    const secretBody = JSON.stringify({ message: 'person@example.com was rejected' });
    const error = await new ResendEmailProvider('test-key', answering(new Response(secretBody, { status }))).send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBe(status);
    expect((error as Error).message).not.toContain('person@example.com');
  });

  it('throws on a network failure, without its details', async () => {
    const error = await new ResendEmailProvider('test-key', answering(new Error('secret detail'))).send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBeNull();
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('does not retry an accepted email just because the answer was unreadable', async () => {
    const fetcher = answering(new Response('not json', { status: 200 }));
    expect(await new ResendEmailProvider('test-key', fetcher).send(message)).toEqual({ messageId: 'unknown' });
  });
});

describe('formatSender', () => {
  it('cannot be used to add recipients or lines', () => {
    expect(formatSender({ name: 'A" <evil@example.com>, "B', email: 'no-reply@example.com' })).toBe('"A\\" <evil@example.com>, \\"B" <no-reply@example.com>');
    expect(formatSender({ name: 'A\r\nBcc: evil@example.com', email: 'x@example.com' })).toBe('"A Bcc: evil@example.com" <x@example.com>');
  });
});
