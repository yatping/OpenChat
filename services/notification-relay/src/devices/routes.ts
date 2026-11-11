import { importPublicKey, parseGrant, RELAY_PROTOCOL_VERSION, verifyGrant } from '@openchat/notification-protocol';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { ID_PATTERN } from '../requests/schemas';
import { findActiveKey } from '../requests/store';
import { admitToGuard, MAX_BODY_BYTES, type Rejection, readSignedHeaders, verifyKnownInstallation } from '../requests/verify';
import { encryptToken, hashSecret, newDeviceSecret, newOpaqueId, secretMatches, tokenLookup } from './crypto';
import { findDeviceSecret, registerAnonymousDevice, removeInstallationSubscription, removeOwnSubscription, subscribeKnownDevice, updateDeviceToken } from './store';

type Ctx = Context<{ Bindings: Env }>;

const id = z.string().regex(ID_PATTERN);
const apnsToken = z.string().regex(/^[0-9a-fA-F]{32,200}$/).transform((token) => token.toLowerCase());
const deviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{1,64}$/);
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9_-]{1,64}$/);

const registerBody = z.strictObject({
  grant: z.string().max(2048),
  platform: z.literal('ios'),
  apnsToken,
  bundleId: z.string().max(155),
  environment: z.enum(['sandbox', 'production']),
  device: z.strictObject({ id: deviceId, secret: z.string().max(128) }).optional(),
});
const tokenBody = z.strictObject({ deviceId, apnsToken });
const unregisterAsDevice = z.strictObject({ deviceId, subscriptionId });
const unregisterAsInstallation = z.union([z.strictObject({ subscriptionId }), z.strictObject({ workspaceId: id, recipientId: id })]);

function problem(c: Ctx, status: 400 | 401 | 403 | 409 | 413 | 422 | 429 | 503, code: string, retryAfterSeconds?: number) {
  if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ code, status, title: code.replaceAll('_', ' '), protocolVersion: RELAY_PROTOCOL_VERSION }, status);
}
const rejection = (c: Ctx, r: Rejection) => problem(c, r.status, r.code, 'retryAfterSeconds' in r ? r.retryAfterSeconds : undefined);

async function readBody(c: Ctx): Promise<Uint8Array | null> {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  const body = new Uint8Array(await c.req.arrayBuffer());
  return body.byteLength > MAX_BODY_BYTES ? null : body;
}

function parse<T extends z.ZodType>(schema: T, body: Uint8Array): z.infer<T> | null {
  try {
    const result = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const bearer = (c: Ctx) => /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];

async function deviceAuthenticated(env: Env, id: string, presented: string | undefined): Promise<{ bundleId: string } | null> {
  if (!presented) return null;
  const found = await findDeviceSecret(env.DB, id);
  // An unknown device still costs a hash, so the time taken does not reveal which IDs exist.
  const matches = await secretMatches(presented, found?.secretHash ?? (await hashSecret('no-device')));
  return found && matches ? { bundleId: found.bundleId } : null;
}

export function deviceRoutes() {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/v1/devices/register', async (c) => {
    const { RELAY_TOKEN_KEY: tokenKey, RELAY_ID: relayId } = c.env;
    if (!tokenKey || !relayId) return problem(c, 503, 'not_configured');
    const limit = await c.env.DEVICE_LIMIT.limit({ key: c.req.header('cf-connecting-ip') ?? 'unknown' });
    if (!limit.success) return problem(c, 429, 'rate_limited', 60);

    const bytes = await readBody(c);
    if (!bytes) return problem(c, 413, 'body_too_large');
    const body = parse(registerBody, bytes);
    if (!body) return problem(c, 400, 'malformed_request');

    // Every kind of bad grant answers alike. Holding a grant is the authentication here.
    const grant = parseGrant(body.grant);
    if (!grant) return problem(c, 401, 'invalid_grant');
    const key = await findActiveKey(c.env.DB, grant.claims.iss, grant.keyId);
    if (!key) return problem(c, 401, 'invalid_grant');
    if (!(await verifyGrant(await importPublicKey(key.publicKey), grant, relayId))) return problem(c, 401, 'invalid_grant');

    // Checked after the grant, so that only an installation's own members learn what this relay serves.
    const allowed = (c.env.RELAY_BUNDLE_IDS ?? '').split(',').map((value) => value.trim());
    if (!allowed.includes(body.bundleId)) return problem(c, 422, 'bundle_not_supported');
    // A token from the other environment would look invalid to APNs, and be deleted.
    if (body.environment !== (c.env.APNS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production')) return problem(c, 422, 'environment_not_supported');

    const known = body.device ? await deviceAuthenticated(c.env, body.device.id, body.device.secret) : null;
    if (body.device && (!known || known.bundleId !== body.bundleId)) return problem(c, 401, 'invalid_device');

    // Single use, spent last among the checks, so that a mistake above does not cost the app its grant.
    const fresh = await c.env.RELAY_GUARD.getByName(grant.claims.iss).consumeGrant(grant.claims.jti);
    if (!fresh) return problem(c, 401, 'invalid_grant');

    const now = Date.now();
    const encryptedToken = await encryptToken(tokenKey, body.bundleId, body.apnsToken);
    const lookup = await tokenLookup(tokenKey, body.bundleId, body.apnsToken);
    const sub = { subscriptionId: newOpaqueId('sub'), installationId: grant.claims.iss, workspaceId: grant.claims.wid, recipientId: grant.claims.sub, now };
    const fields = { bundleId: body.bundleId, environment: body.environment, encryptedToken, lookup, now };

    if (body.device) {
      const subscribed = await subscribeKnownDevice(c.env.DB, body.device.id, fields, sub);
      if (!subscribed) return problem(c, 403, 'workspace_not_registered');
      return c.json({ deviceId: body.device.id, subscriptionId: subscribed }, 201);
    }

    const secret = newDeviceSecret();
    const registered = await registerAnonymousDevice(c.env.DB, { ...fields, newDeviceId: newOpaqueId('dev'), secretHash: await hashSecret(secret) }, sub);
    if (!registered.subscriptionId) return problem(c, 403, 'workspace_not_registered');
    return c.json({ deviceId: registered.deviceId, deviceSecret: secret, subscriptionId: registered.subscriptionId }, 201);
  });

  routes.post('/v1/devices/token', async (c) => {
    if (!c.env.RELAY_TOKEN_KEY) return problem(c, 503, 'not_configured');
    const bytes = await readBody(c);
    if (!bytes) return problem(c, 413, 'body_too_large');
    const body = parse(tokenBody, bytes);
    if (!body) return problem(c, 400, 'malformed_request');
    const device = await deviceAuthenticated(c.env, body.deviceId, bearer(c));
    if (!device) return problem(c, 401, 'invalid_device');
    await updateDeviceToken(c.env.DB, body.deviceId, {
      bundleId: device.bundleId,
      encryptedToken: await encryptToken(c.env.RELAY_TOKEN_KEY, device.bundleId, body.apnsToken),
      lookup: await tokenLookup(c.env.RELAY_TOKEN_KEY, device.bundleId, body.apnsToken),
      now: Date.now(),
    });
    return c.body(null, 204);
  });

  // A device removes its own subscription, and an installation its own members'. Removing nothing still answers 204.
  routes.post('/v1/devices/unregister', async (c) => {
    const bytes = await readBody(c);
    if (!bytes) return problem(c, 413, 'body_too_large');

    if (c.req.header('authorization')) {
      const body = parse(unregisterAsDevice, bytes);
      if (!body) return problem(c, 400, 'malformed_request');
      if (!(await deviceAuthenticated(c.env, body.deviceId, bearer(c)))) return problem(c, 401, 'invalid_device');
      await removeOwnSubscription(c.env.DB, body.deviceId, body.subscriptionId);
      return c.body(null, 204);
    }

    const signed = readSignedHeaders(c.req.raw.headers);
    if (!signed) return problem(c, 400, 'malformed_request');
    const verified = await verifyKnownInstallation(c.env, { method: c.req.method, path: new URL(c.req.url).pathname, body: bytes }, signed);
    if (verified) return rejection(c, verified);
    const refused = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (refused) return rejection(c, refused);
    const body = parse(unregisterAsInstallation, bytes);
    if (!body) return problem(c, 400, 'malformed_request');
    await removeInstallationSubscription(c.env.DB, signed.installationId, body);
    return c.body(null, 204);
  });

  return routes;
}
