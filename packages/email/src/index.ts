/** Email delivery. Vendor neutral. Drivers arrive in Milestone 1a. See spec amendment A6. */
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
