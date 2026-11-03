/**
 * Typed client for the dashboard and mobile app. Response types are derived from the route definitions,
 * so changing a contract without updating a caller fails to compile. Contracts are imported as types
 * only, which keeps Zod out of client bundles.
 */
import type { getDiscoveryRoute, getHealthRoute } from '@openchat/api-contracts';
import type { z } from 'zod';

type JsonBody<R> = R extends { responses: { 200: { content: { 'application/json': { schema: infer S extends z.ZodType } } } } }
  ? z.output<S>
  : never;

export type HealthResponse = JsonBody<typeof getHealthRoute>;
export type DiscoveryResponse = JsonBody<typeof getDiscoveryRoute>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, title: string, requestId?: string) {
    super(title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface ClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | null | Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

/** There is deliberately no global client: one instance is bound to one installation. See ADR-0010. */
export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function get<T>(path: string): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    const token = await options.getAccessToken?.();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await doFetch(`${baseUrl}${path}`, { headers });
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { code?: string; title?: string; requestId?: string } | null;
      throw new ApiError(response.status, problem?.code ?? 'unknown', problem?.title ?? 'Request failed', problem?.requestId);
    }
    return (await response.json()) as T;
  }

  return {
    getHealth: () => get<HealthResponse>('/health'),
    getDiscovery: () => get<DiscoveryResponse>('/.well-known/openchat.json'),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
