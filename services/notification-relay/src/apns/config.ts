import type { Env } from '../env';
import type { ApnsIdentity } from './provider-token';

export function apnsIdentity(env: Env): ApnsIdentity | null {
  const { APNS_TEAM_ID: teamId, APNS_KEY_ID: keyId, APNS_PRIVATE_KEY: privateKeyPem } = env;
  return teamId && keyId && privateKeyPem ? { teamId, keyId, privateKeyPem } : null;
}

export function apnsHost(env: Env): 'api.push.apple.com' | 'api.sandbox.push.apple.com' {
  return env.APNS_ENVIRONMENT === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
}
