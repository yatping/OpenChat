import { z } from 'zod';

/** Request bodies are closed: an unknown field is a 400. This is how "no conversation data" is enforced in code. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const id = z.string().regex(ID_PATTERN);

export const registerInstallationBody = z.strictObject({
  baseUrl: z.string().max(253 + 8).startsWith('https://'),
  publicKey: z.strictObject({ id, alg: z.literal('Ed25519'), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});

/** The workspace's name is not sent: it travels inside each phone's ciphertext (ADR-0017). */
export const registerWorkspaceBody = z.strictObject({ workspaceId: id });

export const revokeWorkspaceBody = z.strictObject({ workspaceId: id });

/** Asks for everything about the installation to be erased. Nothing else may come with it. */
export const unregisterInstallationBody = z.strictObject({});
