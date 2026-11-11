/** What every email job shares: one send per key, and a log that holds a hash and never an address. */
import { emailRecipientHash } from '@openchat/core';
import { claimEmailDelivery, finishEmailDelivery, type Database } from '@openchat/database';
import { EmailSendError, type EmailMessage, type EmailProvider } from '@openchat/email';
import { createLogger, newId, type JobEnvelope } from '@openchat/shared';
import type { Env } from '../env';

const LIFETIME_MS = 24 * 60 * 60_000;

/** With no provider, nothing is queued, because nothing could be sent. */
export const emailConfigured = (env: Env) => Boolean(env.EMAIL_PROVIDER);

export const systemFrom = (env: Env, publicBaseUrl: string) => env.SYSTEM_EMAIL_FROM ?? `no-reply@${new URL(publicBaseUrl).hostname}`;

export function envelope<T>(type: string, idempotencyKey: string, workspaceId: string, payload: T): JobEnvelope<T> {
  return { v: 1, type, id: newId('job'), idempotencyKey, workspaceId, occurredAt: new Date().toISOString(), notAfter: new Date(Date.now() + LIFETIME_MS).toISOString(), payload };
}

/**
 * Claim, send, record. A repeated job finds the claim and sends nothing. A crash between sending and recording leaves
 * the claim, and nothing sends again, because a missed email is better than a duplicate. A row marked `failed` can be
 * claimed by a retry.
 */
export async function deliverOnce(db: Database, email: EmailProvider, input: { workspaceId: string; dedupeKey: string; template: string; to: string; message: () => EmailMessage | Promise<EmailMessage> }): Promise<void> {
  const { workspaceId, dedupeKey, template } = input;
  if (!(await claimEmailDelivery(db, { workspaceId, dedupeKey, template, recipientHash: await emailRecipientHash(input.to) }))) {
    createLogger({ workspaceId }).info('email_already_claimed');
    return;
  }
  try {
    const sent = await email.send({ ...(await input.message()), idempotencyKey: dedupeKey });
    await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'sent', providerMessageId: sent.messageId });
  } catch (error) {
    // Cloudflare keeps a list of its own, from bounces and complaints. Retrying could not change its answer.
    if (error instanceof EmailSendError && error.code === 'E_RECIPIENT_SUPPRESSED') {
      await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'suppressed' });
      return;
    }
    await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'failed' }).catch(() => undefined);
    throw error;
  }
}

/** Email alerts to members, which were removed (amendment A15). A Worker from before can queue them during a deploy. */
export const RETIRED_HANDLERS = {
  'email.alert': async () => undefined,
  'email.send': async () => undefined,
};
