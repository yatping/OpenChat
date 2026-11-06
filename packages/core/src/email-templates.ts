/** Email that the application sends, apart from account email. Nothing anyone wrote is ever in it. */
import { escapeHtml } from './auth-flows';

const oneLine = (name: string) => name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

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
