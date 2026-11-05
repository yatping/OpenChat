import type { ApnsResponse, ApnsTransport } from '@openchat/notification-protocol';
import type { Env } from '../env';
import { type ApnsAction, classifyApnsResponse } from './classify';
import { apnsHost, apnsIdentity } from './config';
import type { TokenResult } from './credential';

export interface ApnsMessage {
  deviceToken: string;
  topic: string;
  /** Other `apns-*` headers. */
  headers: Record<string, string>;
  body: string;
}

export type ApnsOutcome =
  | { action: ApnsAction; response: ApnsResponse }
  /** Nothing reached APNs, or nothing came back. Retryable. */
  | { action: 'retry'; response?: undefined; failure: 'network' }
  | { action: 'credential_error'; response?: undefined; failure: Extract<TokenResult, { ok: false }>['reason'] };

const CACHE_MS = 5 * 60_000;
let cached: { id: string; token: string; until: number } | undefined;

/** Isolates keep the token briefly, so that each send does not call the Durable Object. */
export function clearProviderTokenCache() {
  cached = undefined;
}

async function providerToken(env: Env, id: string, staleToken?: string): Promise<TokenResult> {
  if (!staleToken && cached?.id === id && Date.now() < cached.until) return { ok: true, token: cached.token };
  const result = await env.APNS_CREDENTIAL.getByName(id).getToken(staleToken);
  if (result.ok) cached = { id, token: result.token, until: Date.now() + CACHE_MS };
  else cached = undefined;
  return result;
}

/** Sends one message. An expired token gets one new token and one more try. */
export async function sendToApns(env: Env, transport: ApnsTransport, message: ApnsMessage): Promise<ApnsOutcome> {
  const identity = apnsIdentity(env);
  if (!identity) return { action: 'credential_error', failure: 'not_configured' };
  const id = `${identity.teamId}:${identity.keyId}`;
  const attempt = async (token: string): Promise<ApnsOutcome> => {
    try {
      const response = await transport.send({
        host: apnsHost(env),
        token: message.deviceToken,
        headers: { ...message.headers, authorization: `bearer ${token}`, 'apns-topic': message.topic },
        body: message.body,
      });
      return { action: classifyApnsResponse(response), response };
    } catch {
      return { action: 'retry', failure: 'network' };
    }
  };

  const token = await providerToken(env, id);
  if (!token.ok) return { action: 'credential_error', failure: token.reason };
  let outcome = await attempt(token.token);
  if (outcome.action === 'refresh_token') {
    const fresh = await providerToken(env, id, token.token);
    if (!fresh.ok) return { action: 'credential_error', failure: fresh.reason };
    outcome = await attempt(fresh.token);
    // Still refused with a new token, so the fault is not its age.
    if (outcome.action === 'refresh_token' && outcome.response) outcome = { action: 'credential_error', response: outcome.response };
  }
  if (outcome.action === 'stop_minting') await env.APNS_CREDENTIAL.getByName(id).pauseMinting();
  return outcome;
}
