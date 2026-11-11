import { MAX_CLOCK_SKEW_SECONDS, RELAY_PROTOCOL_VERSION } from '@openchat/notification-protocol';
import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import type { Env } from '../env';
import { documentProvesControl, normalizeBaseUrl } from './domain-proof';
import { registerInstallationBody, registerWorkspaceBody, revokeWorkspaceBody, sanitizeDisplayName, unregisterInstallationBody } from './schemas';
import { eraseInstallation, findActiveKey, hasInstallation, insertInstallation, revokeWorkspace, upsertWorkspace } from './store';
import { admitToGuard, checkSignature, clearKeyCache, MAX_BODY_BYTES, type Rejection, readSignedHeaders, type SignedHeaders, verifyKnownInstallation } from './verify';

type Ctx = Context<{ Bindings: Env }>;

function problem(c: Ctx, rejection: Rejection | { status: 400 | 403 | 409 | 422 | 429; code: string; retryAfterSeconds?: number }) {
  if ('retryAfterSeconds' in rejection && rejection.retryAfterSeconds !== undefined) c.header('Retry-After', String(rejection.retryAfterSeconds));
  return c.json({ code: rejection.code, status: rejection.status, title: rejection.code.replaceAll('_', ' '), protocolVersion: RELAY_PROTOCOL_VERSION }, rejection.status);
}

/** The first checks, cheapest first, shared by every signed route. Answers null with a rejection set. */
async function readRequest(c: Ctx): Promise<{ ok: true; signed: SignedHeaders; body: Uint8Array; request: { method: string; path: string; body: Uint8Array } } | { ok: false; response: Response }> {
  const signed = readSignedHeaders(c.req.raw.headers);
  if (!signed) return { ok: false, response: problem(c, { status: 400, code: 'malformed_request' }) };
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return { ok: false, response: problem(c, { status: 413, code: 'body_too_large' }) };
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return { ok: false, response: problem(c, { status: 413, code: 'body_too_large' }) };
  if (Math.abs(Date.now() / 1000 - Number(signed.timestamp)) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, response: problem(c, { status: 401, code: 'stale_timestamp' }) };
  return { ok: true, signed, body, request: { method: c.req.method, path: new URL(c.req.url).pathname, body } };
}

function parseBody<T extends z.ZodType>(schema: T, body: Uint8Array): z.infer<T> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function relayRoutes(fetcher: typeof fetch) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/v1/installations/register', async (c) => {
    const read = await readRequest(c);
    if (!read.ok) return read.response;
    const { signed, body, request } = read;
    if (signed.workspaceId !== undefined) return problem(c, { status: 400, code: 'malformed_request' });

    // The key is in the body for a first registration, so parsing comes before the signature here.
    const parsed = parseBody(registerInstallationBody, body);
    if (!parsed || parsed.publicKey.id !== signed.keyId) return problem(c, { status: 400, code: 'malformed_request' });
    const baseUrl = normalizeBaseUrl(parsed.baseUrl);
    if (!baseUrl) return problem(c, { status: 400, code: 'malformed_request' });

    const limit = await c.env.REGISTRATION_LIMIT.limit({ key: c.req.header('cf-connecting-ip') ?? 'unknown' });
    if (!limit.success) return problem(c, { status: 429, code: 'rate_limited', retryAfterSeconds: 60 });

    const rejected = await checkSignature(parsed.publicKey.key, request, signed);
    if (rejected) return problem(c, rejected);
    const refused = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (refused) return problem(c, refused);

    const stored = async () => {
      const key = await findActiveKey(c.env.DB, signed.installationId, signed.keyId);
      return key?.publicKey === parsed.publicKey.key && key.baseUrl === baseUrl;
    };
    if (await hasInstallation(c.env.DB, signed.installationId)) {
      return (await stored()) ? c.json({ status: 'registered' }, 200) : problem(c, { status: 409, code: 'already_registered' });
    }

    if (c.env.RELAY_MODE !== 'open') {
      const allowed = (c.env.RELAY_ALLOWED_INSTALLATIONS ?? '').split(',').map((id) => id.trim());
      if (!allowed.includes(signed.installationId)) return problem(c, { status: 403, code: 'installation_not_allowed' });
    }
    const proven = await documentProvesControl(fetcher, baseUrl, { installationId: signed.installationId, keyId: signed.keyId, publicKey: parsed.publicKey.key });
    if (!proven) return problem(c, { status: 422, code: 'domain_not_verified' });

    await insertInstallation(c.env.DB, { installationId: signed.installationId, baseUrl, keyId: signed.keyId, publicKey: parsed.publicKey.key, now: Date.now() });
    // Another request may have won the race, or this address may belong to another installation.
    return (await stored()) ? c.json({ status: 'registered' }, 201) : problem(c, { status: 409, code: 'already_registered' });
  });

  async function verifyWorkspaceRequest<T extends z.ZodType>(c: Ctx, schema: T) {
    const read = await readRequest(c);
    if (!read.ok) return { ok: false as const, response: read.response };
    const { signed, body, request } = read;
    const rejected = await verifyKnownInstallation(c.env, request, signed);
    if (rejected) return { ok: false as const, response: problem(c, rejected) };
    const refused = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (refused) return { ok: false as const, response: problem(c, refused) };
    const parsed = parseBody(schema, body);
    if (!parsed || (parsed as { workspaceId?: string }).workspaceId !== signed.workspaceId) return { ok: false as const, response: problem(c, { status: 400, code: 'malformed_request' }) };
    return { ok: true as const, signed, parsed };
  }

  routes.post('/v1/workspaces/register', async (c) => {
    const result = await verifyWorkspaceRequest(c, registerWorkspaceBody);
    if (!result.ok) return result.response;
    const outcome = await upsertWorkspace(c.env.DB, {
      installationId: result.signed.installationId,
      workspaceId: result.parsed.workspaceId,
      displayName: sanitizeDisplayName(result.parsed.displayName),
      now: Date.now(),
    });
    return c.json({ status: 'registered' }, outcome === 'created' ? 201 : 200);
  });

  routes.post('/v1/workspaces/revoke', async (c) => {
    const result = await verifyWorkspaceRequest(c, revokeWorkspaceBody);
    if (!result.ok) return result.response;
    await revokeWorkspace(c.env.DB, result.signed.installationId, result.parsed.workspaceId, Date.now());
    return c.body(null, 204);
  });

  // An installation leaving. Signed for the installation, not a workspace. Repeating it after success answers 401,
  // because the key it signed with is gone too.
  routes.post('/v1/installations/unregister', async (c) => {
    const read = await readRequest(c);
    if (!read.ok) return read.response;
    const { signed, body, request } = read;
    if (signed.workspaceId !== undefined) return problem(c, { status: 400, code: 'malformed_request' });
    const rejected = await verifyKnownInstallation(c.env, request, signed);
    if (rejected) return problem(c, rejected);
    const refused = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (refused) return problem(c, refused);
    if (!parseBody(unregisterInstallationBody, body)) return problem(c, { status: 400, code: 'malformed_request' });
    await eraseInstallation(c.env.DB, signed.installationId);
    // Other isolates forget the key within 30 seconds. Until then a request passes the signature check and finds nothing.
    clearKeyCache();
    return c.body(null, 204);
  });

  return routes;
}
