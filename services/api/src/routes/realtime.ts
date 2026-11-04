import { connectRealtimeRoute, REALTIME_PROTOCOL_VERSION } from '@openchat/api-contracts';
import { verifyConnection } from '@openchat/core';
import { CLAIMS_HEADER, hubName, roomName, type SocketAttachment } from '@openchat/realtime';
import { AppError } from '@openchat/shared';
import { authDeps, type App } from '../context';

export function registerRealtimeRoutes(app: App) {
  app.openapi(connectRealtimeRoute, async (c) => {
    const claims = await verifyConnection(await authDeps(c.env), c.req.valid('query').ticket, c.req.header('origin'));
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new AppError(426, 'upgrade_required', 'This route only accepts a WebSocket upgrade');

    const attachment: SocketAttachment = {
      kind: claims.kind,
      principalId: claims.sub,
      role: claims.role ?? null,
      expiresAt: claims.until,
      connectedAt: Date.now(),
      protocolVersion: REALTIME_PROTOCOL_VERSION,
    };
    // Only ever set here. The objects have no route of their own, so a client cannot supply this header.
    const headers = { upgrade: 'websocket', [CLAIMS_HEADER]: JSON.stringify(attachment) };
    const stub = claims.kind === 'agent' ? c.env.WORKSPACE_HUB.getByName(hubName(claims.wid)) : c.env.CONVERSATION_ROOM.getByName(roomName(claims.wid, claims.conv!));
    // The contract has no body for 101, and Hono's types have no way to say so for a raw Response.
    return stub.fetch('https://realtime.invalid/connect', { headers }) as never;
  });
}
