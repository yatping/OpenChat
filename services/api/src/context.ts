import { turnstileFor } from './turnstile';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { importSigningKey, importVerificationKeys, type SerializedKey, type SigningKey, type VerificationKeys } from '@openchat/auth';
import type { AuthDeps, RateLimiter } from '@openchat/core';
import { getInstallation, openDatabase, type Principal } from '@openchat/database';
import { AppError, type JobEnvelope, type Logger } from '@openchat/shared';
import type { Env } from './env';

export type AppEnv = { Bindings: Env; Variables: { requestId: string; log: Logger; principal: Principal } };
export type App = OpenAPIHono<AppEnv>;

interface LoadedKeys {
  source: string;
  signingKey: SigningKey;
  verificationKeys: VerificationKeys;
}
let keys: LoadedKeys | undefined;

async function loadKeys(secret: string | undefined): Promise<LoadedKeys> {
  if (!secret) throw new AppError(503, 'not_configured', 'Authentication is not configured');
  if (keys?.source === secret) return keys;
  const parsed = JSON.parse(secret) as { active: SerializedKey; retired?: Pick<SerializedKey, 'kid' | 'publicKey'>[] };
  keys = {
    source: secret,
    signingKey: await importSigningKey(parsed.active),
    verificationKeys: await importVerificationKeys([parsed.active, ...(parsed.retired ?? [])]),
  };
  return keys;
}

// The installation's identity never changes once set, so one read per isolate is enough.
let installationId: string | undefined;

function limiterFor(env: Env): RateLimiter {
  return {
    consume: (key, limit, windowSeconds) => env.AUTH_GUARD.getByName(key).consume(limit, windowSeconds),
    reset: (key) => env.AUTH_GUARD.getByName(key).reset(),
  };
}

export async function authDeps(env: Env): Promise<AuthDeps> {
  const db = openDatabase(env.DB);
  if (!installationId) {
    const installation = await getInstallation(db);
    if (!installation) throw new AppError(503, 'not_initialized', 'This installation has not been initialised');
    installationId = installation.id;
  }
  const { signingKey, verificationKeys } = await loadKeys(env.AUTH_SIGNING_KEY);
  const turnstile = turnstileFor(env);
  return {
    ...(turnstile ? { turnstile } : {}),
    db,
    installationId,
    signingKey,
    verificationKeys,
    limiter: limiterFor(env),
    emailJobs: {
      send: async (job: JobEnvelope) => {
        await env.EMAIL_QUEUE.send(job);
      },
      sendBatch: async (jobs: JobEnvelope[]) => {
        await env.EMAIL_QUEUE.sendBatch(jobs.map((body) => ({ body })));
      },
    },
  };
}
