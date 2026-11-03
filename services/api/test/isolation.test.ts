/**
 * The tenant isolation harness. It reads every route from the contract and from the running app, so a new
 * route fails here until someone decides how it is isolated. See ADR-0004.
 */
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { ALL_ROUTES } from '@openchat/api-contracts/document';
import { hashPassword } from '@openchat/auth';
import type { JobEnvelope } from '@openchat/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import worker from '../src/index';

type Scoped = {
  kind: 'workspace';
  /** Sent in every request, so that a request is refused for its tenant and not for a malformed body. */
  body?: Record<string, unknown>;
  /** What the workspace's own owner gets. This proves the case reaches the real resource. */
  ownerStatus: number;
};
type Unscoped = { kind: 'public' | 'self'; reason: string };
type Case = Scoped | Unscoped;

/** Keyed by operationId. Adding a route without an entry here fails the first test below. */
const CASES: Record<string, Case> = {
  getHealth: { kind: 'public', reason: 'Status only' },
  getDiscovery: { kind: 'public', reason: 'Describes the installation. No workspace data' },
  login: { kind: 'public', reason: 'Acts only on the submitted credentials' },
  refreshSession: { kind: 'public', reason: 'Acts only on the session of the presented token' },
  requestPasswordReset: { kind: 'public', reason: 'Answers the same for every address' },
  confirmPasswordReset: { kind: 'public', reason: 'Acts only on the user of the presented token' },
  confirmEmailVerification: { kind: 'public', reason: 'Acts only on the user of the presented token' },
  acceptInvitation: { kind: 'public', reason: 'Acts only on the workspace of the presented token' },
  logout: { kind: 'self', reason: 'Revokes the caller’s own session' },
  getMe: { kind: 'self', reason: 'Filtered to the caller’s own memberships. Covered in auth.test.ts' },
  deleteMe: { kind: 'self', reason: 'Acts on the caller’s own account' },
  createWorkspace: { kind: 'self', reason: 'Creates a new workspace. Reads no existing one' },
  getWorkspace: { kind: 'workspace', ownerStatus: 200 },
  updateWorkspace: { kind: 'workspace', body: { name: 'Taken over' }, ownerStatus: 200 },
  listMembers: { kind: 'workspace', ownerStatus: 200 },
  updateMember: { kind: 'workspace', body: { role: 'supervisor' }, ownerStatus: 200 },
  removeMember: { kind: 'workspace', ownerStatus: 204 },
  createInvitation: { kind: 'workspace', body: { email: 'new@example.com', role: 'agent' }, ownerStatus: 201 },
  listWebsites: { kind: 'workspace', ownerStatus: 200 },
  createWebsite: { kind: 'workspace', body: { name: 'Taken over', allowedOrigins: [] }, ownerStatus: 201 },
  updateWebsite: { kind: 'workspace', body: { name: 'Taken over' }, ownerStatus: 200 },
};

/** Served by the app, but not part of the versioned contract. */
const APP_ROUTES_OUTSIDE_THE_CONTRACT = ['GET /api/v1/openapi.json'];

/** The first test applies this to the real routes, and the second proves that it can fail. */
function uncovered(routes: readonly { operationId?: string | undefined }[], cases: Record<string, unknown>): string[] {
  return routes.map((r) => r.operationId ?? '(no operationId)').filter((id) => !(id in cases));
}

const contractRoutes = ALL_ROUTES.map((route) => ({
  id: route.operationId,
  method: route.method.toUpperCase(),
  path: route.path,
  isPublic: Array.isArray(route.security) && route.security.length === 0,
}));
const scopedRoutes = contractRoutes.filter((r) => CASES[r.id]?.kind === 'workspace');

// Hono writes parameters as :name and the contract as {name}.
const servedRoutes = () =>
  createApp()
    .routes.filter((r) => r.method !== 'ALL')
    .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);

describe('every route is accounted for', () => {
  it('has a case for each route in the contract', () => {
    expect(uncovered(ALL_ROUTES, CASES)).toEqual([]);
  });

  it('notices a route with no case', () => {
    expect(uncovered([...ALL_ROUTES, { operationId: 'brandNewRoute' }], CASES)).toEqual(['brandNewRoute']);
  });

  it('has no case for a route that no longer exists', () => {
    const ids = new Set(contractRoutes.map((r) => r.id));
    expect(Object.keys(CASES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('serves nothing that is missing from the contract, so nothing can avoid the cases', () => {
    const contract = new Set(contractRoutes.map((r) => `${r.method} ${r.path}`));
    const extra = servedRoutes().filter((route) => !contract.has(route) && !APP_ROUTES_OUTSIDE_THE_CONTRACT.includes(route));
    expect(extra).toEqual([]);
  });

  it('serves everything in the contract', () => {
    const served = new Set(servedRoutes());
    expect(contractRoutes.map((r) => `${r.method} ${r.path}`).filter((route) => !served.has(route))).toEqual([]);
  });

  it('agrees with the contract about which routes are public', () => {
    for (const route of contractRoutes) expect([route.id, route.isPublic]).toEqual([route.id, CASES[route.id]?.kind === 'public']);
  });

  it('treats every route with a workspace in its path as scoped', () => {
    for (const route of contractRoutes) expect([route.id, route.path.includes('{workspaceId}')]).toEqual([route.id, CASES[route.id]?.kind === 'workspace']);
  });
});

// ---------- Against the running app ----------

const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';
const testEnv = { ...env, EMAIL_QUEUE: { send: async (_job: JobEnvelope) => undefined } } as unknown as Env;

/** Resources in each workspace, by the name of the path parameter that holds them. */
const RESOURCES: Record<'a' | 'b', Record<string, string>> = {
  a: { workspaceId: 'work_a', memberId: 'mem_a_agent', websiteId: 'site_a' },
  b: { workspaceId: 'work_b', memberId: 'mem_b_agent', websiteId: 'site_b' },
};

function urlFor(path: string, ...sources: Record<string, string>[]): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    for (const source of sources) if (source[name]) return source[name];
    throw new Error(`The isolation harness has no fixture for {${name}}. Add one to RESOURCES.`);
  });
}

let requests = 0;
const request = (method: string, path: string, token: string | null, body?: Record<string, unknown>) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        // Its own address each time, so that sign-in limits never decide a result here.
        'cf-connecting-ip': `192.0.2.${++requests}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    testEnv,
    createExecutionContext(),
  );

const TABLES = ['workspaces', 'workspace_members', 'websites', 'invitations', 'audit_log'];

/** Every row belonging to workspace A. A refused request must leave this exactly as it was. */
async function snapshotOfA(): Promise<string> {
  const rows = await Promise.all(
    TABLES.map((table) => env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'} = 'work_a' ORDER BY 1`).all()),
  );
  return JSON.stringify(rows.map((r) => r.results));
}

let passwordHash = '';
const tokens = { ownerA: '', ownerB: '' };

async function seed() {
  await env.DB.batch([...TABLES.filter((t) => t !== 'workspaces'), 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    ...(['a', 'b'] as const).flatMap((w) => [
      env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?2, ?2, 1, 1)`).bind(`work_${w}`, `workspace-${w}`),
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, 'Owner', ?3, 1, 1), (?4, ?5, 'Agent', '!', 1, 1)`)
        .bind(`user_${w}_owner`, `owner-${w}@example.com`, passwordHash, `user_${w}_agent`, `agent-${w}@example.com`),
      env.DB.prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
         (?1, ?2, ?3, 'owner', 'active', 1, 1), (?4, ?2, ?5, 'agent', 'active', 1, 1)`,
      ).bind(`mem_${w}_owner`, `work_${w}`, `user_${w}_owner`, `mem_${w}_agent`, `user_${w}_agent`),
      env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES (?1, ?2, 'Site', ?3, 1, 1)`).bind(`site_${w}`, `work_${w}`, `key_${w}`),
    ]),
  ]);
}

async function signIn(email: string) {
  const response = await request('POST', '/api/v1/auth/login', null, { email, password: PASSWORD, clientType: 'mobile' });
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

describe('across tenants', () => {
  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    await seed();
    tokens.ownerA = await signIn('owner-a@example.com');
    tokens.ownerB = await signIn('owner-b@example.com');
  });

  const bodyOf = (id: string) => (CASES[id] as Scoped).body;

  it.each(contractRoutes.filter((r) => !r.isPublic))('$id refuses a request with no token', async ({ method, path, id }) => {
    const before = await snapshotOfA();
    const response = await request(method, urlFor(path, RESOURCES.a), null, CASES[id]?.kind === 'workspace' ? bodyOf(id) : undefined);
    expect(response.status).toBe(401);
    expect(await snapshotOfA()).toBe(before);
  });

  it.each(scopedRoutes)('$id answers 404 to the owner of another workspace', async ({ method, path, id }) => {
    const before = await snapshotOfA();
    const response = await request(method, urlFor(path, RESOURCES.a), tokens.ownerB, bodyOf(id));
    expect(response.status).toBe(404);
    expect(await snapshotOfA()).toBe(before);
  });

  it.each(scopedRoutes.filter((r) => [...r.path.matchAll(/\{(\w+)\}/g)].length > 1))(
    '$id answers 404 when another workspace’s resource is named under your own',
    async ({ method, path, id }) => {
      const before = await snapshotOfA();
      const { workspaceId } = RESOURCES.b;
      const response = await request(method, urlFor(path, { workspaceId: workspaceId! }, RESOURCES.a), tokens.ownerB, bodyOf(id));
      expect(response.status).toBe(404);
      expect(await snapshotOfA()).toBe(before);
    },
  );

  it.each(scopedRoutes)('$id answers 404 for a workspace that does not exist, the same as for someone else’s', async ({ method, path, id }) => {
    const strip = async (response: Response) => {
      const body = (await response.json()) as Record<string, unknown>;
      delete body.requestId;
      return [response.status, body];
    };
    const foreign = await request(method, urlFor(path, RESOURCES.a), tokens.ownerB, bodyOf(id));
    const missing = await request(method, urlFor(path, { workspaceId: 'work_missing' }, RESOURCES.a), tokens.ownerB, bodyOf(id));
    expect(await strip(foreign)).toEqual(await strip(missing));
  });

  // Without this, a route that always answered 404 would pass everything above.
  it.each(scopedRoutes)('$id does work for the workspace’s own owner', async ({ method, path, id }) => {
    const response = await request(method, urlFor(path, RESOURCES.a), tokens.ownerA, bodyOf(id));
    expect(response.status).toBe((CASES[id] as Scoped).ownerStatus);
  });
});
