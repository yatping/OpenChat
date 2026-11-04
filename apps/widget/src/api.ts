/**
 * The visitor API, written by hand because Zod does not fit the budget. Contracts are imported as types only,
 * so the compiler still checks these shapes against the server's.
 */
import type {
  VisitorConversationSchema,
  VisitorWireMessageSchema,
  WidgetBootstrapSchema,
} from '@openchat/api-contracts';

export type Bootstrap = (typeof WidgetBootstrapSchema)['_output'];
export type VisitorConversation = (typeof VisitorConversationSchema)['_output'];
export type VisitorMessage = (typeof VisitorWireMessageSchema)['_output'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Request failed with ${status}`);
  }
}

export interface Session {
  refreshToken: string;
  accessToken: string;
  /** Milliseconds. */
  expiresAt: number;
}

export interface ApiDeps {
  apiUrl: string;
  websiteKey: string;
  loadSession(): Session | null;
  saveSession(session: Session): void;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 15_000;
/** Earlier than expiry, so that a token does not run out on its way to the server. */
const EXPIRY_MARGIN_MS = 30_000;

export function createApi(deps: ApiDeps) {
  const request = async (method: string, path: string, token: string | null, body?: unknown): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Called through the global, so that a host page wrapping fetch still gets a correct `this`.
      const send = deps.fetch ?? fetch;
      return await send(`${deps.apiUrl}${path}`, {
        method,
        // Bearer tokens only: nothing ambient goes with a cross-origin call.
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const failure = async (response: Response) => {
    const problem = (await response.json().catch(() => null)) as { code?: string } | null;
    const retryAfter = Number(response.headers.get('retry-after'));
    return new ApiError(response.status, problem?.code ?? null, retryAfter > 0 ? retryAfter : null);
  };

  /** One at a time, so that a burst of calls does not make a burst of sessions. */
  let starting: Promise<Session> | null = null;
  const startSession = (): Promise<Session> => {
    starting ??= (async () => {
      const refreshToken = deps.loadSession()?.refreshToken;
      const response = await request('POST', '/api/v1/widget/sessions', null, { websiteKey: deps.websiteKey, ...(refreshToken ? { refreshToken } : {}) });
      if (!response.ok) throw await failure(response);
      const body = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };
      const session = { refreshToken: body.refreshToken, accessToken: body.accessToken, expiresAt: Date.parse(body.accessTokenExpiresAt) };
      deps.saveSession(session);
      return session;
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const token = async () => {
    const session = deps.loadSession();
    return session && session.expiresAt - EXPIRY_MARGIN_MS > Date.now() ? session.accessToken : (await startSession()).accessToken;
  };

  const authed = async (method: string, path: string, body?: unknown): Promise<Response> => {
    let response = await request(method, path, await token(), body);
    if (response.status === 401) response = await request(method, path, (await startSession()).accessToken, body);
    if (!response.ok) throw await failure(response);
    return response;
  };

  const conversationPath = (id: string) => `/api/v1/widget/conversations/${encodeURIComponent(id)}`;

  return {
    hasSession: () => deps.loadSession() !== null,
    ensureSession: () => token().then(() => undefined),
    async bootstrap(): Promise<Bootstrap> {
      const response = await request('GET', `/api/v1/widget/bootstrap?websiteKey=${encodeURIComponent(deps.websiteKey)}`, null);
      if (!response.ok) throw await failure(response);
      return (await response.json()) as Bootstrap;
    },
    async updateProfile(input: { name?: string; email?: string }): Promise<void> {
      await authed('PATCH', '/api/v1/widget/me', input);
    },
    async listConversations(): Promise<VisitorConversation[]> {
      return ((await (await authed('GET', '/api/v1/widget/conversations')).json()) as { data: VisitorConversation[] }).data;
    },
    async createConversation(input: { clientMessageId: string; content: string }): Promise<VisitorConversation & { message: VisitorMessage }> {
      return (await (await authed('POST', '/api/v1/widget/conversations', input)).json()) as VisitorConversation & { message: VisitorMessage };
    },
    async sendMessage(conversationId: string, input: { clientMessageId: string; content: string }): Promise<VisitorMessage> {
      return (await (await authed('POST', `${conversationPath(conversationId)}/messages`, input)).json()) as VisitorMessage;
    },
    async listMessages(conversationId: string, query: { afterSeq?: number; beforeSeq?: number; limit: number }): Promise<VisitorMessage[]> {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.afterSeq !== undefined) params.set('afterSeq', String(query.afterSeq));
      if (query.beforeSeq !== undefined) params.set('beforeSeq', String(query.beforeSeq));
      return ((await (await authed('GET', `${conversationPath(conversationId)}/messages?${params}`)).json()) as { data: VisitorMessage[] }).data;
    },
    async markRead(conversationId: string, seq: number): Promise<void> {
      await authed('POST', `${conversationPath(conversationId)}/read`, { deliveredSeq: seq, readSeq: seq });
    },
    async ticket(conversationId: string): Promise<{ ticket: string; url: string }> {
      return (await (await authed('POST', `${conversationPath(conversationId)}/realtime/tickets`)).json()) as { ticket: string; url: string };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
