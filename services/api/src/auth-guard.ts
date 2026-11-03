/**
 * A strict counter per key, for login and recovery throttling. The rate limiting binding is approximate
 * and per location, which is not enough here. See docs/architecture/security.md. One object per hashed key,
 * and an alarm deletes its storage once the window ends, so idle keys cost nothing.
 */
import { DurableObject } from 'cloudflare:workers';

interface Window {
  count: number;
  resetAt: number;
}

export class AuthGuard extends DurableObject {
  async consume(limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = Date.now();
    const stored = this.ctx.storage.kv.get<Window>('window');
    const window: Window = stored && stored.resetAt > now ? { ...stored, count: stored.count + 1 } : { count: 1, resetAt: now + windowSeconds * 1000 };
    this.ctx.storage.kv.put('window', window);
    if (window.count === 1) await this.ctx.storage.setAlarm(window.resetAt);
    return { allowed: window.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete('window');
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.kv.delete('window');
  }
}
