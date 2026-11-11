import { NOTIFICATION_EVENTS } from '@openchat/notification-protocol';
import { describe, expect, it } from 'vitest';
import { PHRASES } from '../../plugins/notification-service/index';

describe('fallback phrases for notifications the extension cannot open', () => {
  it('cover every event, under the key the relay sends', () => {
    // services/notification-relay/src/delivery/payload.ts names them this way.
    const keys = NOTIFICATION_EVENTS.map((event) => `OC_${event.toUpperCase()}`).sort();
    for (const phrases of Object.values(PHRASES)) expect(Object.keys(phrases).sort()).toEqual(keys);
  });
});
