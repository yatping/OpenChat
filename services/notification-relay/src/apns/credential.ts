import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { apnsIdentity } from './config';
import { decideMint, mintProviderToken, MINTING_PAUSE_MS, type StoredToken } from './provider-token';

const STATE_KEY = 'state';

interface State {
  current?: StoredToken;
  noMintUntil: number;
}

export type TokenResult = { ok: true; token: string } | { ok: false; reason: 'not_configured' | 'minting_paused' | 'mint_failed' };

/**
 * One per Apple identity, because isolates come and go and a cache in each could mint many tokens, which APNs
 * punishes. The token is stored so that eviction does not cause a new one. Changes to these methods must be
 * additive: old objects can outlive a deploy.
 */
export class ApnsCredential extends DurableObject<Env> {
  private async state(): Promise<State> {
    return (await this.ctx.storage.get<State>(STATE_KEY)) ?? { noMintUntil: 0 };
  }

  /** `staleToken` is one APNs answered ExpiredProviderToken to. */
  async getToken(staleToken?: string): Promise<TokenResult> {
    let result: TokenResult = { ok: false, reason: 'mint_failed' };
    // Signing awaits outside storage, so this keeps concurrent callers from each minting one.
    await this.ctx.blockConcurrencyWhile(async () => {
      result = await this.resolve(staleToken);
    });
    return result;
  }

  private async resolve(staleToken: string | undefined): Promise<TokenResult> {
    const identity = apnsIdentity(this.env);
    if (!identity) return { ok: false, reason: 'not_configured' };
    const state = await this.state();
    const now = Date.now();
    const decision = decideMint({ current: state.current, keyId: identity.keyId, now, noMintUntil: state.noMintUntil, staleToken });
    if (decision === 'unavailable') return { ok: false, reason: 'minting_paused' };
    if (decision === 'reuse' && state.current) return { ok: true, token: state.current.token };
    try {
      const token = await mintProviderToken(identity, now);
      await this.ctx.storage.put<State>(STATE_KEY, { ...state, current: { token, keyId: identity.keyId, mintedAt: now } });
      return { ok: true, token };
    } catch {
      return { ok: false, reason: 'mint_failed' };
    }
  }

  /** APNs answered TooManyProviderTokenUpdates: stop adding to the problem for a while. */
  async pauseMinting(): Promise<void> {
    await this.ctx.storage.put<State>(STATE_KEY, { ...(await this.state()), noMintUntil: Date.now() + MINTING_PAUSE_MS });
  }
}
