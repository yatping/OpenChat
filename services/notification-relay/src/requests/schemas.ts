import { z } from 'zod';

/** Request bodies are closed: an unknown field is a 400. This is how "no conversation data" is enforced in code. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const id = z.string().regex(ID_PATTERN);

export const registerInstallationBody = z.strictObject({
  baseUrl: z.string().max(253 + 8).startsWith('https://'),
  publicKey: z.strictObject({ id, alg: z.literal('Ed25519'), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});

export const registerWorkspaceBody = z.strictObject({ workspaceId: id, displayName: z.string().max(40).optional() });

export const revokeWorkspaceBody = z.strictObject({ workspaceId: id });

/** Shown as a notification title, so nothing here may disguise it: no control, format, or line characters. */
export function sanitizeDisplayName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return clean.length > 0 ? clean : null;
}
