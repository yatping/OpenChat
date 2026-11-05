/**
 * Alerts say that something happened and where to look. They hold no message text, because a mailbox is outside the
 * installation, and whoever reads it should still have to sign in.
 */
import { escapeHtml } from './auth-flows';

export type AlertKind = 'new_conversation' | 'conversation_unanswered';

const SENTENCE: Record<AlertKind, (workspace: string) => { subject: string; line: string }> = {
  new_conversation: (workspace) => ({ subject: `New conversation in ${workspace}`, line: `A visitor started a new conversation in ${workspace}.` }),
  conversation_unanswered: (workspace) => ({ subject: `A visitor is waiting in ${workspace}`, line: `A visitor in ${workspace} has been waiting for a reply.` }),
};

export function alertEmail(input: { kind: AlertKind; workspaceName: string; publicBaseUrl: string }) {
  // A subject is one line, whatever a name holds.
  const workspace = input.workspaceName.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  const { subject, line } = SENTENCE[input.kind](workspace);
  const link = `${input.publicBaseUrl.replace(/\/+$/, '')}/`;
  const footer = 'You chose to get these emails. You can turn them off under Notifications, after signing in.';
  return {
    subject,
    text: `${line}\n\nOpen the inbox: ${link}\n\n${footer}`,
    html: `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(link)}">Open the inbox</a></p><p>${escapeHtml(footer)}</p>`,
  };
}
