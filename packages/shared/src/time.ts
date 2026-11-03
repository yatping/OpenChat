/** Database timestamps are integer milliseconds UTC. API timestamps are RFC 3339 UTC. */
export const toIso = (ms: number): string => new Date(ms).toISOString();

export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError('Invalid timestamp');
  return ms;
}
