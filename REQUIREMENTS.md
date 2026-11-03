# Open Tidio — Product & Technical Development Specification

**Working name:** Open Tidio  
**Product type:** Open-source, Cloudflare-native customer messaging and live chat platform  
**Primary language:** TypeScript  
**Mobile:** Expo React Native  
**Infrastructure:** Cloudflare  
**License recommendation:** AGPL-3.0  
**Status:** Initial development specification

---

# 1. Product Vision

Build an open-source, self-hostable alternative to Tidio, Intercom and Chatwoot.

The platform enables businesses to communicate with website visitors through a live chat widget, manage conversations through a team inbox, receive mobile push notifications, and follow up with customers through email.

The core product must be deployable entirely within a customer's Cloudflare account.

The project will also provide an official iOS application that connects to multiple independently hosted installations.

The project must support two deployment models:

1. **Managed notification mode:** Customers deploy their own Cloudflare backend but use the official iOS app and the project's shared notification relay.
2. **Fully independent mode:** Customers deploy their own Cloudflare backend, notification relay and build their own iOS application using their own Apple Developer account and APNs credentials.

The project must not require customers to subscribe to a proprietary SaaS service.

## 1.1 Core principles

- Open source and self-hostable.
- Cloudflare-native infrastructure.
- No traditional application servers.
- No mandatory PostgreSQL, Redis or Kubernetes.
- TypeScript across backend and frontend.
- API-first architecture.
- Real-time communication.
- Mobile-first agent experience.
- Multi-tenant support within each installation.
- Multiple independent Cloudflare installations supported by the official iOS app.
- Customer data remains under the customer's control.
- Notification infrastructure can be replaced or self-hosted.
- Deployment and upgrades must be reproducible.

# 2. Product Scope

## 2.1 Website visitor experience

Provide an embeddable JavaScript chat widget.

Features:

- Floating chat button.
- Customisable widget theme.
- Welcome message.
- Business availability status.
- Online/offline status.
- Real-time messaging.
- Typing indicators.
- Message delivery status.
- Conversation history.
- Visitor name and email collection.
- File and image attachments.
- Unread message counter.
- Responsive mobile and desktop UI.
- Reconnection after network interruption.
- Anonymous visitor sessions.
- Persistent visitor identity where consent and browser capabilities allow.
- Multiple websites per workspace.

The widget should be installable using a simple script:

```html
<script>
  window.OpenTidioConfig = {
    websiteId: "YOUR_WEBSITE_ID",
    apiUrl: "https://api.example.com"
  };
</script>

<script
  async
  src="https://cdn.example.com/widget.js">
</script>
```

The exact configuration should be finalised during implementation.

The widget must not require customers to use a specific frontend framework.

Support vanilla JavaScript, React, Next.js and other websites.

## 2.2 Agent dashboard

Build a web application for support agents.

Main sections:

1. Inbox
2. Contacts
3. Websites
4. Team members
5. Canned responses
6. Automation rules
7. Email settings
8. Notification settings
9. Workspace settings

### Inbox

The inbox should support:

- All conversations.
- Unassigned conversations.
- Assigned to me.
- Assigned to team.
- Open conversations.
- Pending conversations.
- Resolved conversations.
- Archived conversations.

Conversation operations:

- Assign conversation to an agent.
- Assign conversation to a team.
- Transfer conversation.
- Add internal notes.
- Send messages.
- Send attachments.
- Mark as resolved.
- Reopen conversation.
- Add tags.
- Change priority.
- View visitor information.
- View conversation history.

Real-time updates should be reflected without refreshing the page.

### Contact management

Store visitor information:

- Name.
- Email.
- Phone number (optional).
- Visitor identifier.
- Custom attributes.
- Tags.
- First seen.
- Last seen.
- Conversation history.

Allow agents to merge duplicate contacts with appropriate permission checks.

### Team management

Support:

- Workspace owner.
- Administrator.
- Supervisor.
- Agent.

Implement role-based access control.

Workspace owners can manage billing-independent configuration, team members, integrations and security settings.

# 3. iOS Application

Build one official iOS application using Expo React Native and TypeScript.

The application must support multiple independently hosted workspaces.

## 3.1 Login and workspace onboarding

The user journey:

1. Download application from Apple App Store.
2. Create an account or sign in.
3. Connect an existing Open Tidio installation.
4. Authenticate with that installation.
5. Save the workspace connection.
6. Register the device for push notifications.
7. View and respond to conversations.

Support connecting multiple workspaces.

Example:

- Company A → https://support.company-a.com
- Company B → https://support.company-b.com
- Company C → https://chat.company-c.com

Each workspace must have isolated authentication and conversation data.

Do not assume that the same user ID exists across installations.

## 3.2 Mobile screens

Implement:

- Login.
- Connect workspace.
- Workspace selector.
- Conversation inbox.
- Conversation details.
- Message composer.
- Attachment picker.
- Contact details.
- Notification settings.
- User profile.
- Workspace settings.

The UI should be optimised for support agents who need to respond quickly.

## 3.3 Push notifications

Use native APNs integration through Expo or a compatible native implementation.

The official App Store application must use the project's managed notification relay.

Notification registration:

1. Request permission.
2. Obtain APNs device token.
3. Authenticate the user with the selected workspace.
4. Register device and workspace association with the notification relay.
5. Associate device with the authenticated user.
6. Refresh registration when the device token changes.
7. Remove registration on logout or explicit device removal.

Support:

- New conversation.
- New incoming message.
- Conversation assigned.
- Conversation transferred.
- Mention in internal note.
- Important conversation updates.

Notification payloads should contain minimal information:

```json
{
  "event": "new_message",
  "workspaceId": "workspace_123",
  "conversationId": "conversation_456",
  "notificationId": "notification_789"
}
```

Avoid exposing sensitive conversation content in push payloads by default.

When a notification is opened:

- Resolve the workspace.
- Authenticate if necessary.
- Fetch the conversation.
- Navigate to the appropriate conversation screen.

Do not rely on push notifications for message delivery. The backend remains the source of truth.

# 4. Notification Architecture

Notification delivery must be independent of the core messaging backend.

Create a dedicated notification protocol shared between Cloudflare installations and notification relays.

## 4.1 Managed notification mode

Architecture:

```text
Customer Cloudflare Installation
              |
              | Authenticated notification event
              v
      Managed Notification Relay
              |
              v
              APNs
              |
              v
       Official iOS App
```

The project's managed relay owns the APNs credentials associated with the official iOS application.

Customers do not need Apple Developer accounts.

The relay must not store customer conversation history.

It stores only:

- Workspace registration.
- User/device associations.
- Device tokens.
- Notification preferences.
- Delivery metadata.
- Request idempotency records.

## 4.2 Fully independent notification mode

Architecture:

```text
Customer Cloudflare Backend
              |
              v
Customer Notification Relay
              |
              v
             APNs
              |
              v
Customer-built iOS Application
```

Provide an independently deployable notification relay.

Users must configure:

- Apple Developer Team ID.
- APNs Key ID.
- APNs authentication private key.
- iOS Bundle ID.
- APNs environment.

The self-hosted relay must support sandbox and production environments.

The iOS application must be built and signed using the customer's Apple Developer account.

These two components must be documented and deployed together.

Do not distribute the project's official APNs private key to customers.

## 4.3 Notification Relay API

Implement:

```text
POST /v1/workspaces/register
POST /v1/workspaces/revoke

POST /v1/devices/register
POST /v1/devices/unregister

POST /v1/notifications/send
POST /v1/notifications/batch

GET  /v1/notifications/{id}
GET  /health
```

Notification request:

```json
{
  "workspaceId": "workspace_123",
  "event": "new_message",
  "recipientId": "agent_123",
  "conversationId": "conversation_123",
  "notificationId": "event_123",
  "metadata": {
    "websiteId": "website_123"
  }
}
```

The relay must:

- Authenticate the originating workspace.
- Validate request signatures.
- Validate timestamps.
- Prevent replay attacks.
- Apply rate limits.
- Resolve recipient devices.
- Deduplicate events.
- Deliver notifications.
- Retry temporary failures.
- Remove invalid device tokens.
- Record delivery outcomes.

Use HMAC-SHA256 signatures or another well-defined asymmetric authentication protocol.

Include request ID, timestamp and signature headers.

Example:

```text
X-Workspace-ID
X-Request-ID
X-Timestamp
X-Signature
```

The relay must never accept unauthenticated push requests.

# 5. Cloudflare Infrastructure

All customer-facing application infrastructure should use Cloudflare services.

## 5.1 Required services

| Component | Cloudflare service | Responsibility |
|---|---|---|
| Backend API | Workers | HTTP API |
| Real-time sessions | Durable Objects | WebSocket connections |
| Primary database | D1 | Relational application data |
| File storage | R2 | Attachments |
| Background processing | Queues | Async tasks |
| Scheduled jobs | Cron Triggers | Scheduled processing |
| Frontend hosting | Workers / Pages | Dashboard |
| Static assets | Cloudflare CDN | Widget and assets |
| Secrets | Workers Secrets | Credentials |
| Rate limiting | Workers | Abuse prevention |

Avoid introducing external infrastructure unless absolutely necessary.

Apple APNs and external email delivery services are legitimate external dependencies.

## 5.2 Backend architecture

Use modular TypeScript Workers.

Suggested logical modules:

- Authentication.
- Workspaces.
- Users.
- Websites.
- Contacts.
- Conversations.
- Messages.
- Attachments.
- Realtime.
- Notifications.
- Email.
- Automation.
- Settings.

Use a modular monolith architecture initially rather than creating unnecessary microservices.

The notification relay should be a separately deployable application.

## 5.3 Durable Objects

Use Durable Objects for real-time communication.

Responsibilities:

- WebSocket lifecycle.
- Conversation room management.
- Connection tracking.
- Typing indicators.
- Presence.
- Real-time message distribution.
- Connection recovery.
- Broadcasting events to authorised participants.

A conversation should have a clear ownership and routing strategy.

Do not create one Durable Object per individual message.

Use conversation rooms or appropriately partitioned workspace-level objects.

Persist messages in D1 before broadcasting them.

WebSocket delivery should not be the only record of a message.

## 5.4 Cloudflare Queues

Use Queues for:

- Notification dispatch.
- Email delivery.
- Automated follow-ups.
- Attachment processing.
- Webhook delivery.
- Analytics events.

Implement:

- Retry policies.
- Dead-letter queues.
- Idempotent consumers.
- Exponential backoff.
- Failure monitoring.

# 6. Database Design

Use D1 with SQLite.

Use Drizzle ORM for schema definitions and migrations.

Initial entities:

## Workspaces

```text
id
name
slug
created_at
updated_at
```

## Users

```text
id
email
name
password_hash
created_at
updated_at
```

## Workspace Members

```text
id
workspace_id
user_id
role
status
created_at
```

## Websites

```text
id
workspace_id
name
domain
website_key
settings_json
created_at
```

## Contacts

```text
id
workspace_id
visitor_id
name
email
phone
attributes_json
created_at
updated_at
```

## Conversations

```text
id
workspace_id
website_id
contact_id
assigned_user_id
status
priority
subject
last_message_at
created_at
updated_at
```

## Messages

```text
id
workspace_id
conversation_id
sender_type
sender_id
message_type
content
metadata_json
created_at
```

## Attachments

```text
id
workspace_id
message_id
storage_key
filename
content_type
size
created_at
```

## Conversation Events

```text
id
workspace_id
conversation_id
event_type
actor_id
metadata_json
created_at
```

## Devices

```text
id
workspace_id
user_id
platform
device_token
app_bundle_id
push_environment
created_at
updated_at
```

## Notification Preferences

```text
id
workspace_id
user_id
event_type
enabled
created_at
updated_at
```

## Email Settings

```text
id
workspace_id
provider
sender_name
sender_email
configuration_json
created_at
updated_at
```

## Automation Rules

```text
id
workspace_id
name
trigger_type
conditions_json
actions_json
enabled
created_at
updated_at
```

## Important database requirements

- All workspace-owned records must have workspace_id.
- Enforce workspace isolation in every query.
- Use appropriate composite indexes.
- Use foreign keys where appropriate.
- Use migrations rather than modifying production schemas manually.
- Store timestamps in UTC.
- Use UUIDs or another globally unique identifier strategy.
- Never expose D1 database identifiers as authentication credentials.

# 7. Messaging Protocol

Define a consistent message protocol across:

- Website widget.
- Dashboard.
- iOS app.
- Backend.
- Notification relay.

Example message:

```json
{
  "id": "message_123",
  "conversationId": "conversation_123",
  "sender": {
    "type": "visitor",
    "id": "visitor_123"
  },
  "type": "text",
  "content": "Hello, I need some help",
  "createdAt": "2026-11-03T10:00:00Z",
  "metadata": {}
}
```

Message types:

- text
- image
- file
- system
- internal_note

Message statuses:

- accepted
- delivered
- read
- failed

Implement REST APIs for persistence and WebSockets for real-time delivery.

The REST API must remain usable if WebSockets disconnect.

Define API schemas using OpenAPI 3.1.

Use shared TypeScript types generated from or validated against the API contract.

# 8. Email and Follow-up Automation

Implement email support as a separate delivery module.

Support:

- New conversation email alerts.
- Unanswered conversation alerts.
- Visitor follow-up emails.
- Agent notifications.
- Conversation transcript emails (with appropriate permissions).

## 8.1 Email provider abstraction

Define a common interface:

```typescript
interface EmailProvider {
  send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{
    messageId: string;
  }>;
}
```

Support Cloudflare Email Service where available and configurable SMTP or external transactional email providers as alternatives.

Do not make the application depend on one email vendor.

## 8.2 Visitor follow-up

Example workflow:

1. Visitor starts conversation.
2. Visitor provides an email address.
3. Visitor leaves the website.
4. Conversation becomes inactive.
5. Configured automation evaluates whether follow-up is appropriate.
6. A follow-up email is queued.
7. Email is sent if consent, suppression and timing rules allow it.
8. Reply handling can reopen or associate the conversation.

Do not interpret browser disconnection alone as proof that a visitor has abandoned a conversation.

Support configurable inactivity thresholds.

Example:

```json
{
  "trigger": "conversation_inactive",
  "conditions": {
    "inactiveMinutes": 30,
    "visitorEmailExists": true,
    "conversationStatus": "open",
    "followUpConsent": true
  },
  "actions": [
    {
      "type": "send_email",
      "template": "follow_up"
    }
  ]
}
```

Implement unsubscribe management and suppression lists.

Inbound email replies should be a later feature, not a prerequisite for the initial MVP.

# 9. Authentication and Security

Security is a first-class requirement.

## Authentication

Support:

- Email/password authentication.
- Password reset.
- Email verification.
- Session management.
- Access and refresh tokens.
- Workspace-scoped permissions.

Consider passkeys in a future release.

## Website visitor authentication

The website widget should use short-lived visitor tokens.

Never expose workspace admin credentials or privileged API keys in website JavaScript.

Implement:

- Website-specific public identifiers.
- Server-side domain validation.
- Visitor session tokens.
- Token expiration.
- Abuse protection.
- Message rate limiting.

## Data isolation

A user must only access resources belonging to authorised workspaces.

Every API request must verify:

1. User identity.
2. Workspace membership.
3. Required permission.
4. Resource ownership.

## Secrets

Use Cloudflare Workers Secrets for production credentials.

Never commit:

- APNs private keys.
- Email credentials.
- Authentication secrets.
- API tokens.
- Database credentials.

Provide `.env.example` files containing placeholders only.

## Attachments

- Validate file types.
- Enforce size limits.
- Use short-lived signed download URLs or authorised proxy downloads.
- Avoid public buckets by default.
- Consider malware scanning as a future integration.

# 10. Web Dashboard Technology

Use:

- React.
- TypeScript.
- Tailwind CSS.
- A reusable component system.
- TanStack Query or equivalent.
- WebSocket client.

The dashboard should be responsive, with an initial focus on desktop.

Recommended layout:

```text
+--------------------------------------------------+
| Workspace selector              User profile     |
+------------+--------------------+----------------+
| Navigation | Conversation list  | Conversation   |
|            |                    |                |
| Inbox      | Visitor A          | Message        |
| Contacts   | Visitor B          | Message        |
| Websites   | Visitor C          |                |
| Settings   |                    | Reply composer |
+------------+--------------------+----------------+
```

Use optimistic updates only where consistency can be safely maintained.

# 11. Website Widget Technology

Build the widget as a standalone TypeScript package.

Requirements:

- Small initial bundle.
- Lazy loading.
- CSS isolation.
- Shadow DOM or another robust isolation strategy.
- No dependency on the host application's React version.
- Mobile responsiveness.
- Accessibility.
- Secure communication with the backend.
- Configurable branding.
- Multi-language support.

The widget should not block the host website from loading.

# 12. Repository Structure

Use a monorepo with pnpm workspaces and Turborepo.

Recommended structure:

```text
open-tidio/
│
├── apps/
│   ├── dashboard/
│   ├── mobile/
│   └── widget/
│
├── services/
│   ├── api/
│   ├── realtime/
│   ├── notification-relay/
│   └── email-worker/
│
├── packages/
│   ├── shared/
│   ├── database/
│   ├── api-client/
│   ├── api-contracts/
│   ├── auth/
│   ├── ui/
│   └── notification-protocol/
│
├── infrastructure/
│   ├── cloudflare/
│   ├── migrations/
│   └── scripts/
│
├── deployment/
│   ├── managed/
│   └── independent/
│
├── docs/
│   ├── architecture/
│   ├── development/
│   ├── self-hosting/
│   ├── notification-relay/
│   ├── ios-build/
│   └── operations/
│
├── .github/
│   └── workflows/
│
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── README.md
```

# 13. Deployment Architecture

## 13.1 Standard deployment

Customer owns the application infrastructure.

```text
Customer Cloudflare Account
    |
    ├── API Worker
    ├── Durable Objects
    ├── D1
    ├── R2
    ├── Queues
    └── Dashboard / Widget
              |
              v
       Managed Push Relay
              |
              v
             APNs
              |
              v
       Official iOS App
```

Provide a deployment wizard or CLI.

The installation process should:

1. Authenticate with Cloudflare.
2. Select the Cloudflare account.
3. Create or configure resources.
4. Apply database migrations.
5. Deploy Workers.
6. Configure secrets.
7. Configure domains.
8. Generate initial workspace credentials.
9. Verify deployment.
10. Print dashboard and widget URLs.

Use Wrangler as the primary deployment tool.

## 13.2 Independent deployment

```text
Customer Cloudflare Account
    |
    ├── API Worker
    ├── Durable Objects
    ├── D1
    ├── R2
    ├── Queues
    ├── Dashboard
    └── Notification Relay
              |
              v
             APNs
              |
              v
       Customer-built iOS App
```

Provide documentation for:

- Apple Developer enrolment.
- App ID creation.
- APNs key creation.
- Bundle ID configuration.
- iOS environment configuration.
- EAS configuration.
- Xcode build.
- TestFlight.
- App Store submission.

The official app's APNs credentials must never be included in the open-source repository.

# 14. Build Configuration and White Labelling

The mobile application should support configurable builds.

Example:

```typescript
export interface AppConfiguration {
  appName: string;
  bundleIdentifier: string;
  apiUrl: string;
  notificationRelayUrl: string;
  pushEnabled: boolean;
  branding: {
    primaryColor: string;
    logo: string;
  };
}
```

Important:

- Bundle identifier is a build-time value.
- APNs identity must match the application's Apple Developer Team and Bundle ID.
- API endpoint and relay endpoint can be runtime configuration.
- App name, icon and splash screen must be configured during the build.
- Each customer is responsible for their own Apple signing and App Store account.

Provide an Expo app configuration template and build profiles.

# 15. Observability and Operations

Implement:

- Structured JSON logging.
- Request IDs.
- Error reporting.
- Queue failure monitoring.
- Durable Object connection metrics.
- API latency metrics.
- Notification delivery metrics.
- Email delivery metrics.

Do not log:

- Passwords.
- Access tokens.
- APNs private keys.
- Full message contents by default.
- Sensitive personal information.

Provide health endpoints.

Example:

```text
GET /health
GET /health/database
GET /health/queues
GET /health/realtime
GET /health/notifications
```

Health endpoints must not expose secrets or internal sensitive configuration.

# 16. Testing Strategy

Use Vitest for unit and integration testing.

Use Playwright for dashboard end-to-end testing.

Use appropriate React Native testing tools for mobile.

Test categories:

### Backend

- Authentication.
- Workspace isolation.
- Message persistence.
- Message ordering.
- Conversation assignment.
- Permission enforcement.
- Queue retries.
- Notification authentication.

### Realtime

- Multiple connected agents.
- Visitor and agent communication.
- Reconnection.
- Duplicate event handling.
- Connection recovery.

### Notifications

- Device registration.
- Multiple devices per user.
- Multiple workspaces.
- Invalid APNs tokens.
- APNs temporary failures.
- Request signature verification.
- Replay protection.
- Idempotency.

### Widget

- Anonymous visitors.
- Returning visitors.
- Message submission.
- Offline reconnection.
- File upload.
- Responsive UI.

### Mobile

- Multiple workspace connections.
- Workspace switching.
- Push registration.
- Notification deep links.
- Login expiration.
- Logout and device removal.

# 17. Development Milestones

Build incrementally. Do not attempt to implement all features in one pass.

## Phase 0 — Project foundation

Deliver:

- Monorepo.
- TypeScript configuration.
- Shared packages.
- Cloudflare local development.
- D1 schema and migrations.
- CI pipeline.
- Architecture documentation.
- OpenAPI conventions.

Acceptance criteria:

- All packages build.
- Lint and tests pass.
- Local Cloudflare development environment works.
- Database migrations work.

## Phase 1 — Core messaging

Deliver:

- Authentication.
- Workspaces.
- Workspace members.
- Website registration.
- Visitor sessions.
- Contacts.
- Conversations.
- Messages.
- WebSocket real-time messaging.
- Basic dashboard.
- Basic website widget.

Acceptance criteria:

- A visitor can start a conversation.
- An agent can receive and reply.
- Messages persist in D1.
- Multiple agents can join.
- Workspace isolation is enforced.

## Phase 2 — iOS application

Deliver:

- Expo application.
- Login.
- Workspace connection.
- Workspace selector.
- Inbox.
- Conversation details.
- Message composer.
- Realtime updates.
- Push notification registration.

Acceptance criteria:

- A user can connect to multiple independent installations.
- Switching workspaces never leaks conversation data.
- Agents can reply from iOS.

## Phase 3 — Managed notification relay

Deliver:

- Shared notification relay.
- Device registration.
- Workspace authentication.
- APNs delivery.
- Retry processing.
- Notification preferences.
- Deep linking.

Acceptance criteria:

- A new visitor message generates a push notification.
- Correct agent devices receive the notification.
- Invalid device tokens are removed.
- Temporary APNs failures are retried.
- The relay cannot access conversation history.

## Phase 4 — Email and automation

Deliver:

- Email provider abstraction.
- Email configuration.
- Email notification templates.
- Background email jobs.
- Inactivity detection.
- Configurable follow-up rules.
- Unsubscribe handling.

Acceptance criteria:

- A qualifying inactive conversation can trigger a follow-up email.
- Duplicate emails are prevented.
- Unsubscribed contacts are excluded.
- Failed email jobs can be retried.

## Phase 5 — Independent deployment

Deliver:

- Standalone notification relay deployment.
- Self-hosted APNs configuration.
- Expo build configuration.
- White-label configuration.
- Self-hosting documentation.
- Deployment CLI.

Acceptance criteria:

- A customer can deploy the entire backend to their Cloudflare account.
- A customer can deploy their own notification relay.
- A customer can build their own iOS application.
- No managed relay credentials are required.
- Notifications work with their own APNs identity.

## Phase 6 — Advanced functionality

Future features:

- Multiple teams and departments.
- Canned responses.
- Advanced automation.
- AI chatbot.
- AI response suggestions.
- Conversation summaries.
- Knowledge base.
- Customer satisfaction surveys.
- Business hours.
- Advanced analytics.
- WhatsApp and other messaging integrations.

# 18. Non-functional Requirements

Performance:

- Fast initial widget loading.
- Efficient WebSocket handling.
- Pagination for conversation history.
- Avoid unnecessary database queries.
- Background processing for non-critical work.

Reliability:

- Persistent messages.
- Idempotent operations.
- Queue retry mechanisms.
- Reconnection handling.
- Notification delivery monitoring.

Security:

- Workspace isolation.
- RBAC.
- Signed relay requests.
- Secret management.
- Input validation.
- Rate limiting.
- Audit logs.

Maintainability:

- Strict TypeScript.
- Shared types.
- OpenAPI contracts.
- Database migrations.
- Automated tests.
- Clear module boundaries.
- No unnecessary custom infrastructure.

# 19. Development Rules for Claude Code

Follow these rules throughout implementation:

1. Read the project specification before implementing features.
2. Do not implement the entire platform in a single pass.
3. Start by producing a detailed implementation plan for the current milestone.
4. Implement one milestone at a time.
5. Keep the application runnable after each milestone.
6. Do not introduce technologies outside the agreed stack without documenting the reason.
7. Prefer Cloudflare-native capabilities.
8. Do not introduce PostgreSQL, Redis, Kubernetes or traditional backend servers.
9. Use TypeScript consistently.
10. Use shared API contracts.
11. All public APIs must have OpenAPI documentation.
12. All database changes must use migrations.
13. Every workspace-owned query must enforce workspace isolation.
14. Every asynchronous operation must consider retries and idempotency.
15. Never hardcode secrets.
16. Never expose privileged credentials in browser or mobile applications.
17. Keep notification relay independent from the messaging backend.
18. Keep managed and independent deployment configurations separate.
19. Write tests for important business logic.
20. Update documentation when architecture or APIs change.

Before each milestone:

- Explain the implementation approach.
- Identify dependencies.
- Identify security implications.
- List expected files and modules.

After each milestone:

- Run tests.
- Run lint.
- Run type checks.
- Verify deployment.
- Summarise completed functionality.
- Document outstanding issues.
- Do not claim a feature is complete if it has not been tested.

# 20. Definition of Done

The first production-ready release must demonstrate this complete journey:

1. A developer deploys Open Tidio to their Cloudflare account.
2. They create a workspace and register a website.
3. They embed the chat widget.
4. A visitor starts a conversation.
5. An agent receives the message in the dashboard.
6. The agent replies.
7. The visitor receives the reply in real time.
8. The agent receives a push notification on iOS when a new message arrives.
9. The agent responds using the iOS app.
10. An inactive conversation can trigger an email follow-up.
11. A different customer can deploy an independent installation.
12. The official iOS app can connect to both installations.

A second acceptance journey must demonstrate complete independence:

1. A customer deploys their own backend.
2. They deploy their own notification relay.
3. They configure their own Apple Developer credentials.
4. They build their own iOS application.
5. They publish or distribute their application.
6. Push notifications work without using the project's managed relay.

The core messaging functionality must remain operational even if the managed notification relay is unavailable.

---

# Final Development Objective

Build a genuinely open-source, Cloudflare-native customer messaging platform that combines the usability of Tidio with the infrastructure ownership of self-hosted software.

Prioritise a working end-to-end messaging experience before advanced automation or AI functionality.

The initial goal is a reliable MVP with:

- Website chat widget.
- Real-time messaging.
- Team inbox.
- Multi-workspace iOS application.
- Managed push notifications.
- Independent notification relay.
- Self-hosted deployment.
- Email follow-ups.

All subsequent development should preserve the ability to deploy and operate the platform independently.
