/**
 * Alerts say that something happened and where to look. They hold no message text, because a mailbox is outside the
 * installation, and whoever reads it should still have to sign in.
 */
import { escapeHtml } from './auth-flows';

const oneLine = (name: string) => name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

export type AlertKind = 'new_conversation' | 'conversation_unanswered';

const SENTENCE: Record<AlertKind, (workspace: string) => { subject: string; line: string }> = {
  new_conversation: (workspace) => ({ subject: `New conversation in ${workspace}`, line: `A visitor started a new conversation in ${workspace}.` }),
  conversation_unanswered: (workspace) => ({ subject: `A visitor is waiting in ${workspace}`, line: `A visitor in ${workspace} has been waiting for a reply.` }),
};

export function alertEmail(input: { kind: AlertKind; workspaceName: string; publicBaseUrl: string }) {
  const workspace = oneLine(input.workspaceName);
  const { subject, line } = SENTENCE[input.kind](workspace);
  const link = `${input.publicBaseUrl.replace(/\/+$/, '')}/`;
  const footer = 'You chose to get these emails. You can turn them off under Notifications, after signing in.';
  return {
    subject,
    text: `${line}\n\nOpen the inbox: ${link}\n\n${footer}`,
    html: `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(link)}">Open the inbox</a></p><p>${escapeHtml(footer)}</p>`,
  };
}

/** To a visitor who asked for it. Fixed text, so that nothing anyone wrote, and no internal note, can be in it. */
export function followUpEmail(input: { workspaceName: string; websiteUrl: string | null; unsubscribeUrl: string }) {
  const workspace = oneLine(input.workspaceName);
  const line = `Your conversation with ${workspace} has gone quiet. If you still need help, we would be glad to hear from you.`;
  const back = input.websiteUrl ? `Come back to the chat at ${input.websiteUrl}` : null;
  const why = 'You are getting this because you asked to be emailed about this conversation.';
  return {
    subject: `Do you still need help from ${workspace}?`,
    text: [line, back, why, `Stop these emails: ${input.unsubscribeUrl}`].filter(Boolean).join('\n\n'),
    html: [
      `<p>${escapeHtml(line)}</p>`,
      input.websiteUrl ? `<p><a href="${escapeHtml(input.websiteUrl)}">Come back to the chat</a></p>` : '',
      `<p>${escapeHtml(why)} <a href="${escapeHtml(input.unsubscribeUrl)}">Stop these emails</a></p>`,
    ].join(''),
  };
}
