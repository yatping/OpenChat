import { createRoute, z } from '@hono/zod-openapi';
import { problemResponse } from './common';

export const HealthSchema = z.object({ status: z.literal('ok') }).openapi('Health');

export const getHealthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['discovery'],
  security: [], // Deliberately public.
  operationId: 'getHealth',
  summary: 'Liveness only. Exposes no configuration.',
  responses: {
    200: { description: 'Healthy', content: { 'application/json': { schema: HealthSchema } } },
    default: problemResponse,
  },
});

export const DiscoverySchema = z
  .object({
    installationId: z.string(),
    name: z.string(),
    api: z.object({ versions: z.array(z.string()), minor: z.number().int() }),
    realtime: z.object({ protocolVersions: z.array(z.number().int()) }),
    relay: z
      .object({
        id: z.string(),
        url: z.string(),
        bundleIds: z.array(z.string()),
        publicKeys: z.array(z.object({ id: z.string(), alg: z.literal('Ed25519'), key: z.string() })),
      })
      .nullable()
      .openapi({ description: 'Compared by the app with its build-time allowlist, and read by the relay to prove domain control.' }),
    auth: z.object({ signup: z.enum(['invite_only', 'open']) }),
  })
  .openapi('Discovery');

export const getDiscoveryRoute = createRoute({
  method: 'get',
  path: '/.well-known/openchat.json',
  tags: ['discovery'],
  security: [], // Deliberately public.
  operationId: 'getDiscovery',
  summary: 'Describe this installation and its compatibility',
  responses: {
    200: { description: 'Discovery document', content: { 'application/json': { schema: DiscoverySchema } } },
    default: problemResponse,
  },
});

export const API_MINOR_VERSION = 0;
