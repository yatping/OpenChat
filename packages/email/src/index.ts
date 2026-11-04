/** Email delivery. Vendor neutral. See spec amendment A6. */
export interface EmailMessage {
  to: string;
  from: { name: string; email: string };
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  /** Passed to providers that support it, to narrow the duplicate window on retry. */
  idempotencyKey?: string;
}

export interface EmailProvider {
  send(input: EmailMessage): Promise<{ messageId: string }>;
}

/**
 * For local development only. Records messages, and prints them so that reset links can be used. This
 * deliberately bypasses the shared logger, and deployments never select it.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(input: EmailMessage): Promise<{ messageId: string }> {
    this.sent.push(input);
    console.log(`[console email] to=${input.to} subject=${input.subject}\n${input.text ?? input.html}`);
    return { messageId: `console-${this.sent.length}` };
  }
}

/** Holds only a status or an error code. A provider's own message can quote addresses, and errors end up in logs. */
export class EmailSendError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(status: number | null, code: string | null = null) {
    super(code ? `The email provider answered ${code}` : status === null ? 'The email provider could not be reached' : `The email provider answered ${status}`);
    this.name = 'EmailSendError';
    this.status = status;
    this.code = code;
  }
}

const SEND_TIMEOUT_MS = 10_000;

const withoutControlCharacters = (name: string) => name.replace(/\p{Cc}+/gu, ' ');

/** A display name, quoted so that it cannot add addresses or line breaks to the sender. */
export function formatSender(from: EmailMessage['from']): string {
  const name = withoutControlCharacters(from.name).replace(/["\\]/g, '\\$&');
  return `"${name}" <${from.email}>`;
}

/**
 * Resend over HTTP. Every failure throws and is retried, then dead-lettered. That includes 4xx answers, so
 * a bad API key or an unverified domain is visible to the operator rather than quietly losing email. A key
 * reused with a different body gets a 409, so callers must not reuse one across different content.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
  }

  async send(input: EmailMessage): Promise<{ messageId: string }> {
    let response: Response;
    try {
      response = await this.#fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: formatSender(input.from),
          to: [input.to],
          subject: input.subject,
          html: input.html,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      throw new EmailSendError(null);
    }
    if (!response.ok) throw new EmailSendError(response.status);
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    // Accepted is accepted. Throwing here would retry, and could send the email twice.
    return { messageId: typeof body?.id === 'string' ? body.id : 'unknown' };
  }
}

/** The part of Cloudflare's `send_email` binding used here, so that this package needs no Workers types. */
export interface CloudflareEmailBinding {
  send(message: {
    to: string;
    from: { name: string; email: string };
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

const CLOUDFLARE_ERROR_CODE = /^E_[A-Z_]{1,64}$/;

/**
 * Cloudflare Email Service, through the Worker's binding. Every failure throws and is retried, then
 * dead-lettered, as with Resend. The binding documents no idempotency key, so `idempotencyKey` is unused and
 * a retry after a lost answer can send twice.
 */
export class CloudflareEmailProvider implements EmailProvider {
  readonly #binding: CloudflareEmailBinding;

  constructor(binding: CloudflareEmailBinding) {
    this.#binding = binding;
  }

  async send(input: EmailMessage): Promise<{ messageId: string }> {
    try {
      return await this.#binding.send({
        to: input.to,
        from: { name: withoutControlCharacters(input.from.name), email: input.from.email },
        subject: input.subject,
        html: input.html,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new EmailSendError(null, typeof code === 'string' && CLOUDFLARE_ERROR_CODE.test(code) ? code : null);
    }
  }
}
