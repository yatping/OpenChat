/** Queue job envelope. Carries IDs, never content. See docs/architecture/background-jobs.md. */
export interface JobEnvelope<T = unknown> {
  v: 1;
  type: string;
  id: string;
  /** Stable across retries and re-dispatches. */
  idempotencyKey: string;
  workspaceId: string | null;
  occurredAt: string;
  /** Drop the job if it is processed after this time. */
  notAfter?: string;
  payload: T;
}

/** min(3600, 5 * 2^attempts) seconds, with +/- 20% jitter. `random` is injectable for tests. */
export function retryDelaySeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(3600, 5 * 2 ** Math.max(0, attempts));
  return Math.round(base * (0.8 + random() * 0.4));
}
