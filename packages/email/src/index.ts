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

/** For local development. Records messages rather than delivering them. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(input: EmailMessage): Promise<{ messageId: string }> {
    this.sent.push(input);
    return { messageId: `console-${this.sent.length}` };
  }
}
