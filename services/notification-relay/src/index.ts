import { RELAY_PROTOCOL_VERSION } from '@openchat/notification-protocol';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' as const }));
app.notFound((c) => c.json({ code: 'not_found', status: 404, title: 'Not found', protocolVersion: RELAY_PROTOCOL_VERSION }, 404));

export default app;
