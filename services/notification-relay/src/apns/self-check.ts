import type { ApnsTransport } from '@openchat/notification-protocol';
import type { Env } from '../env';
import { type ApnsOutcome, sendToApns } from './client';
import { apnsIdentity } from './config';

/**
 * Not a real device, so no phone can ever receive this. APNs checks the provider token first and the topic after
 * the device: on real APNs, a made-up topic also answered BadDeviceToken. So this proves the path and the key, not the topic.
 */
const PROBE_DEVICE_TOKEN = '0'.repeat(64);

export type SelfCheckResult =
  | { outcome: 'not_configured' }
  /** The only healthy answer: the connection works, and APNs accepted the key before refusing the device. Says nothing about the topic. */
  | { outcome: 'ok'; status: number; reason: string; durationMs: number }
  | { outcome: 'credential_error' | 'unreachable' | 'unexpected'; status?: number; reason?: string; durationMs: number };

function describe(result: ApnsOutcome): 'ok' | 'credential_error' | 'unreachable' | 'unexpected' {
  if (result.response?.status === 400 && result.response.reason === 'BadDeviceToken') return 'ok';
  if (result.action === 'credential_error' || result.action === 'refresh_token' || result.action === 'stop_minting') return 'credential_error';
  return result.response ? 'unexpected' : 'unreachable';
}

/** ADR-0006: the path to APNs is undocumented behaviour, so check that it still works. */
export async function runApnsSelfCheck(env: Env, transport: ApnsTransport): Promise<SelfCheckResult> {
  if (!apnsIdentity(env) || !env.APNS_SELF_CHECK_TOPIC) return { outcome: 'not_configured' };
  const started = Date.now();
  const result = await sendToApns(env, transport, {
    deviceToken: PROBE_DEVICE_TOKEN,
    topic: env.APNS_SELF_CHECK_TOPIC,
    headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': '0', 'content-type': 'application/json' },
    body: JSON.stringify({ aps: { alert: 'OpenChat self-check' } }),
  });
  const durationMs = Date.now() - started;
  const outcome = describe(result);
  const details = { ...(result.response ? { status: result.response.status } : {}), ...(result.response?.reason ? { reason: result.response.reason } : {}), durationMs };
  return outcome === 'ok' ? { outcome, status: 400, reason: 'BadDeviceToken', durationMs } : { outcome, ...details };
}
