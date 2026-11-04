import { OpenAPIHono } from '@hono/zod-openapi';
import { ProblemSchema } from './common';
import { AgentClientFrameSchema, AgentServerFrameSchema, VisitorClientFrameSchema, VisitorServerFrameSchema } from './realtime';
import {
  acceptInvitationRoute,
  confirmEmailVerificationRoute,
  confirmPasswordResetRoute,
  createInvitationRoute,
  createWebsiteRoute,
  createWorkspaceRoute,
  deleteMeRoute,
  createVisitorConversationRoute,
  createVisitorSessionRoute,
  listVisitorConversationsRoute,
  listVisitorMessagesRoute,
  markVisitorConversationReadRoute,
  sendVisitorMessageRoute,
  updateVisitorProfileRoute,
  widgetBootstrapRoute,
  connectRealtimeRoute,
  createAgentTicketRoute,
  createTagRoute,
  deleteTagRoute,
  getContactRoute,
  listTagsRoute,
  setConversationTagsRoute,
  updateContactRoute,
  createVisitorTicketRoute,
  getConversationRoute,
  getDiscoveryRoute,
  getWorkspaceRoute,
  listConversationsRoute,
  listMessagesRoute,
  markConversationReadRoute,
  sendMessageRoute,
  updateConversationRoute,
  listMembersRoute,
  listWebsitesRoute,
  removeMemberRoute,
  updateMemberRoute,
  updateWebsiteRoute,
  updateWorkspaceRoute,
  getHealthRoute,
  getMeRoute,
  loginRoute,
  logoutRoute,
  refreshRoute,
  requestPasswordResetRoute,
} from './routes';

/** Every route must be listed here so that it reaches the published document. */
export const ALL_ROUTES = [
  getContactRoute,
  updateContactRoute,
  listTagsRoute,
  createTagRoute,
  deleteTagRoute,
  setConversationTagsRoute,
  createAgentTicketRoute,
  createVisitorTicketRoute,
  connectRealtimeRoute,
  widgetBootstrapRoute,
  createVisitorSessionRoute,
  updateVisitorProfileRoute,
  listVisitorConversationsRoute,
  createVisitorConversationRoute,
  listVisitorMessagesRoute,
  sendVisitorMessageRoute,
  markVisitorConversationReadRoute,
  listConversationsRoute,
  getConversationRoute,
  updateConversationRoute,
  listMessagesRoute,
  sendMessageRoute,
  markConversationReadRoute,
  getHealthRoute,
  getDiscoveryRoute,
  loginRoute,
  refreshRoute,
  logoutRoute,
  requestPasswordResetRoute,
  confirmPasswordResetRoute,
  confirmEmailVerificationRoute,
  getMeRoute,
  deleteMeRoute,
  createWorkspaceRoute,
  getWorkspaceRoute,
  updateWorkspaceRoute,
  listMembersRoute,
  updateMemberRoute,
  removeMemberRoute,
  createInvitationRoute,
  acceptInvitationRoute,
  listWebsitesRoute,
  createWebsiteRoute,
  updateWebsiteRoute,
] as const;

export function buildOpenApiDocument() {
  const app = new OpenAPIHono();
  for (const route of ALL_ROUTES) app.openAPIRegistry.registerPath(route);
  // OpenAPI has no first-class WebSocket support, so frames are published as schemas from the same source.
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'visitorAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A visitor token from POST /api/v1/widget/sessions.' });
  app.openAPIRegistry.register('Problem', ProblemSchema);
  app.openAPIRegistry.register('AgentServerFrame', AgentServerFrameSchema);
  app.openAPIRegistry.register('AgentClientFrame', AgentClientFrameSchema);
  app.openAPIRegistry.register('VisitorServerFrame', VisitorServerFrameSchema);
  app.openAPIRegistry.register('VisitorClientFrame', VisitorClientFrameSchema);
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'OpenChat Installation API',
      version: '1.0.0',
      description: 'REST contract for the dashboard, mobile app, and widget.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    tags: [
      { name: 'discovery', description: 'Installation discovery and health.' },
      { name: 'auth', description: 'Sign-in, sessions, and account recovery.' },
      { name: 'workspaces', description: 'Workspaces, members, and invitations.' },
      { name: 'websites', description: 'Websites that embed the widget.' },
    ],
    servers: [{ url: '/' }],
  });
}
