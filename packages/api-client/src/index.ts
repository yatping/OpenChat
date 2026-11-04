/**
 * Typed client for the dashboard and mobile app. Response types are derived from the route definitions,
 * so changing a contract without updating a caller fails to compile. Contracts are imported as types
 * only, which keeps Zod out of client bundles.
 */
import type {
  createAgentTicketRoute,
  createTagRoute,
  getContactRoute,
  updateContactRoute,
  createInvitationRoute,
  createWebsiteRoute,
  createWorkspaceRoute,
  getDiscoveryRoute,
  getHealthRoute,
  getConversationRoute,
  getMeRoute,
  listConversationsRoute,
  listMembersRoute,
  listMessagesRoute,
  listWebsitesRoute,
  loginRoute,
  sendMessageRoute,
  AttachmentSchema,
  updateConversationRoute,
  updateMemberRoute,
  updateWebsiteRoute,
  updateWorkspaceRoute,
} from '@openchat/api-contracts';
import type { z } from 'zod';

type Schema<R, Status extends number> = R extends { responses: Record<Status, { content: { 'application/json': { schema: infer S extends z.ZodType } } }> } ? S : never;
type Json200<R> = z.output<Schema<R, 200>>;
type Json201<R> = z.output<Schema<R, 201>>;
type BodyOf<R> = R extends { request: { body: { content: { 'application/json': { schema: infer S extends z.ZodType } } } } } ? z.input<S> : never;

export type HealthResponse = Json200<typeof getHealthRoute>;
export type DiscoveryResponse = Json200<typeof getDiscoveryRoute>;
export type TokenPair = Json200<typeof loginRoute>;
export type Me = Json200<typeof getMeRoute>;
export type Workspace = Json200<typeof updateWorkspaceRoute>;
export type MemberPage = Json200<typeof listMembersRoute>;
export type Member = MemberPage['data'][number];
export type Website = Json200<typeof listWebsitesRoute>['data'][number];
export type WebsiteInput = BodyOf<typeof createWebsiteRoute>;
export type WebsiteUpdate = BodyOf<typeof updateWebsiteRoute>;
export type MemberUpdate = BodyOf<typeof updateMemberRoute>;
export type InvitationInput = BodyOf<typeof createInvitationRoute>;
export type Invitation = Json201<typeof createInvitationRoute>;
export type LoginInput = BodyOf<typeof loginRoute>;
export type CreatedWorkspace = Json201<typeof createWorkspaceRoute>;
export type Conversation = Json200<typeof getConversationRoute>;
export type ConversationPage = Json200<typeof listConversationsRoute>;
export type ConversationUpdate = BodyOf<typeof updateConversationRoute>;
export type Message = Json200<typeof listMessagesRoute>['data'][number];
export type MessageInput = BodyOf<typeof sendMessageRoute>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type RealtimeTicket = Json201<typeof createAgentTicketRoute>;
export type Tag = Json201<typeof createTagRoute>;
export type Contact = Json200<typeof getContactRoute>;
export type ContactUpdate = BodyOf<typeof updateContactRoute>;

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
  /** Called once when a request answers 401. Return true if a new access token is now available. */
  onUnauthorized?: () => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
}

/** There is deliberately no global client: one instance is bound to one installation. See ADR-0010. */
export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function send(method: string, path: string, body: unknown, file?: { data: Blob; type: string }): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' });
    const token = await options.getAccessToken?.();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (file) headers.set('content-type', file.type);
    const payload = file ? { body: file.data } : body === undefined ? {} : { body: JSON.stringify(body) };
    return doFetch(`${baseUrl}${path}`, { method, headers, ...payload });
  }

  async function checked(method: string, path: string, body?: unknown, file?: { data: Blob; type: string }): Promise<Response> {
    let response = await send(method, path, body, file);
    if (response.status === 401 && options.onUnauthorized && (await options.onUnauthorized())) {
      response = await send(method, path, body, file);
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { code?: string; title?: string; requestId?: string } | null;
      throw new ApiError(response.status, problem?.code ?? 'unknown', problem?.title ?? 'Request failed', problem?.requestId);
    }
    return response;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await checked(method, path, body);
    if (response.status === 202 || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const get = <T>(path: string) => request<T>('GET', path);
  const workspace = (id: string) => `/api/v1/workspaces/${encodeURIComponent(id)}`;
  const conversation = (workspaceId: string, id: string) => `${workspace(workspaceId)}/conversations/${encodeURIComponent(id)}`;
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
    return params.size > 0 ? `?${params}` : '';
  };

  return {
    getHealth: () => get<HealthResponse>('/health'),
    getDiscovery: () => get<DiscoveryResponse>('/.well-known/openchat.json'),

    login: (input: LoginInput) => request<TokenPair>('POST', '/api/v1/auth/login', input),
    logout: () => request<void>('POST', '/api/v1/auth/logout'),
    requestPasswordReset: (email: string) => request<void>('POST', '/api/v1/auth/password-reset/request', { email }),
    confirmPasswordReset: (token: string, password: string) => request<void>('POST', '/api/v1/auth/password-reset/confirm', { token, password }),
    acceptInvitation: (input: { token: string; name?: string; password?: string }) => request<{ workspaceId: string }>('POST', '/api/v1/invitations/accept', input),
    getMe: () => get<Me>('/api/v1/me'),

    createWorkspace: (name: string) => request<CreatedWorkspace>('POST', '/api/v1/workspaces', { name }),
    listMembers: (workspaceId: string, cursor?: string) => get<MemberPage>(`${workspace(workspaceId)}/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    updateMember: (workspaceId: string, memberId: string, input: MemberUpdate) =>
      request<Member>('PATCH', `${workspace(workspaceId)}/members/${encodeURIComponent(memberId)}`, input),
    removeMember: (workspaceId: string, memberId: string) => request<void>('DELETE', `${workspace(workspaceId)}/members/${encodeURIComponent(memberId)}`),
    invite: (workspaceId: string, input: InvitationInput) => request<Invitation>('POST', `${workspace(workspaceId)}/invitations`, input),
    listWebsites: (workspaceId: string) => get<{ data: Website[] }>(`${workspace(workspaceId)}/websites`),
    createWebsite: (workspaceId: string, input: WebsiteInput) => request<Website>('POST', `${workspace(workspaceId)}/websites`, input),
    updateWebsite: (workspaceId: string, websiteId: string, input: WebsiteUpdate) =>
      request<Website>('PATCH', `${workspace(workspaceId)}/websites/${encodeURIComponent(websiteId)}`, input),

    listConversations: (workspaceId: string, input: { status: Conversation['status']; assignee?: string | undefined; cursor?: string | undefined }) =>
      get<ConversationPage>(`${workspace(workspaceId)}/conversations${query({ ...input, limit: 50 })}`),
    getConversation: (workspaceId: string, id: string) => get<Conversation>(conversation(workspaceId, id)),
    updateConversation: (workspaceId: string, id: string, input: ConversationUpdate) => request<Conversation>('PATCH', conversation(workspaceId, id), input),
    listMessages: (workspaceId: string, id: string, input: { afterSeq?: number | undefined; beforeSeq?: number | undefined } = {}) =>
      get<{ data: Message[] }>(`${conversation(workspaceId, id)}/messages${query({ ...input, limit: 50 })}`),
    /** The file's own type decides whether it is allowed. A browser reports none for some files, which are refused. */
    uploadAttachment: async (workspaceId: string, id: string, file: File): Promise<Attachment> =>
      (await (await checked('POST', `${conversation(workspaceId, id)}/attachments?filename=${encodeURIComponent(file.name)}`, undefined, { data: file, type: file.type || 'application/octet-stream' })).json()) as Attachment,
    /** `url` is the path from an attachment. It needs the token, so a file is fetched, not linked. */
    downloadAttachment: async (url: string): Promise<Blob> => (await checked('GET', url)).blob(),
    sendMessage: (workspaceId: string, id: string, input: MessageInput) => request<Message>('POST', `${conversation(workspaceId, id)}/messages`, input),
    markConversationRead: (workspaceId: string, id: string, seq: number) => request<void>('POST', `${conversation(workspaceId, id)}/read`, { deliveredSeq: seq, readSeq: seq }),
    getContact: (workspaceId: string, id: string) => get<Contact>(`${workspace(workspaceId)}/contacts/${encodeURIComponent(id)}`),
    updateContact: (workspaceId: string, id: string, input: ContactUpdate) => request<Contact>('PATCH', `${workspace(workspaceId)}/contacts/${encodeURIComponent(id)}`, input),
    listTags: (workspaceId: string) => get<{ data: Tag[] }>(`${workspace(workspaceId)}/tags`),
    createTag: (workspaceId: string, name: string) => request<Tag>('POST', `${workspace(workspaceId)}/tags`, { name }),
    setConversationTags: (workspaceId: string, id: string, tagIds: string[]) => request<void>('PUT', `${conversation(workspaceId, id)}/tags`, { tagIds }),
    createRealtimeTicket: (workspaceId: string) => request<RealtimeTicket>('POST', `${workspace(workspaceId)}/realtime/tickets`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
