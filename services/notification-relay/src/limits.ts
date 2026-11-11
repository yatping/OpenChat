/**
 * Every limit the relay enforces, set by the operator in Worker variables. A missing or invalid value takes the
 * default; 0 turns that limit off. See docs/notification-relay/protocol.md#rate-limits.
 */
export interface RelayLimits {
  /** Each installation, refilled evenly. */
  notificationsPerMinute: number;
  notificationBurst: number;
  /** Each installation, per UTC day. */
  notificationsPerDay: number;
  /** Each recipient of an installation, refilled evenly. */
  recipientNotificationsPerMinute: number;
  recipientBurst: number;
  /** Devices subscribed to one installation, across its workspaces. */
  devicesPerInstallation: number;
  /** Open mode only. New installations from one IP address in an hour. */
  newInstallationsPerIpPerHour: number;
  /** Open mode only. New installations across the whole relay, in any 24 hours. */
  newInstallationsPerDay: number;
}

/** Defaults for a managed relay, decided by the owner on 2026-11-11. */
export const DEFAULT_LIMITS: RelayLimits = {
  notificationsPerMinute: 60,
  notificationBurst: 300,
  notificationsPerDay: 10_000,
  recipientNotificationsPerMinute: 30,
  recipientBurst: 30,
  devicesPerInstallation: 500,
  newInstallationsPerIpPerHour: 3,
  newInstallationsPerDay: 200,
};

/** The Worker variable for each limit. */
export const LIMIT_VARIABLES: Record<keyof RelayLimits, string> = {
  notificationsPerMinute: 'RELAY_NOTIFICATIONS_PER_MINUTE',
  notificationBurst: 'RELAY_NOTIFICATION_BURST',
  notificationsPerDay: 'RELAY_NOTIFICATIONS_PER_DAY',
  recipientNotificationsPerMinute: 'RELAY_RECIPIENT_NOTIFICATIONS_PER_MINUTE',
  recipientBurst: 'RELAY_RECIPIENT_BURST',
  devicesPerInstallation: 'RELAY_DEVICES_PER_INSTALLATION',
  newInstallationsPerIpPerHour: 'RELAY_NEW_INSTALLATIONS_PER_IP_PER_HOUR',
  newInstallationsPerDay: 'RELAY_NEW_INSTALLATIONS_PER_DAY',
};

/** The limits that travel to `RelayGuard` with each notification. */
export type NotificationLimits = Pick<RelayLimits, 'notificationsPerMinute' | 'notificationBurst' | 'notificationsPerDay' | 'recipientNotificationsPerMinute' | 'recipientBurst'>;

function count(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function overridesFrom(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The relay's limits, with any raised for one installation in `RELAY_LIMIT_OVERRIDES`: a JSON object keyed by
 * installation ID, each holding the limits to change, by their names in `RelayLimits`.
 */
export function limitsFor(env: object, installationId?: string): RelayLimits {
  const vars = env as Record<string, unknown>;
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_VARIABLES) as (keyof RelayLimits)[]) limits[key] = count(vars[LIMIT_VARIABLES[key]]) ?? limits[key];
  if (installationId) {
    const own = overridesFrom(vars.RELAY_LIMIT_OVERRIDES)[installationId];
    if (own && typeof own === 'object') {
      for (const key of Object.keys(DEFAULT_LIMITS) as (keyof RelayLimits)[]) limits[key] = count((own as Record<string, unknown>)[key]) ?? limits[key];
    }
  }
  return limits;
}

export function notificationLimits(limits: RelayLimits): NotificationLimits {
  const { notificationsPerMinute, notificationBurst, notificationsPerDay, recipientNotificationsPerMinute, recipientBurst } = limits;
  return { notificationsPerMinute, notificationBurst, notificationsPerDay, recipientNotificationsPerMinute, recipientBurst };
}
