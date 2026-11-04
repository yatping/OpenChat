/**
 * The abuse limits an operator can change for a whole installation. They apply to every website. Workspaces cannot
 * change them, because a full database stops every tenant on it. See docs/operations/abuse-limits.md.
 */
export const ABUSE_LIMITS = {
  /** Visitor messages one website can receive in a day. Agents are never counted. */
  messagesPerWebsitePerDay: { variable: 'LIMIT_MESSAGES_PER_WEBSITE_PER_DAY', flag: 'messages-per-website-per-day', default: 20_000, min: 1, max: 10_000_000 },
  /** Visitor messages from one address in a minute. Well above one person, because many people can share an address. */
  messagesPerIpPerMinute: { variable: 'LIMIT_MESSAGES_PER_IP_PER_MINUTE', flag: 'messages-per-ip-per-minute', default: 60, min: 1, max: 100_000 },
  /** The longest visitor message. The ceiling is the longest message the API accepts from anyone. */
  messageMaxChars: { variable: 'LIMIT_MESSAGE_MAX_CHARS', flag: 'message-max-chars', default: 4_000, min: 1, max: 16_000 },
  /** How much of an IPv6 address counts as one address, because one connection usually holds a whole /64. */
  ipv6Prefix: { variable: 'LIMIT_IPV6_PREFIX', flag: 'ipv6-prefix', default: 64, min: 32, max: 128 },
} as const;

export type AbuseLimitName = keyof typeof ABUSE_LIMITS;
export type AbuseLimits = Record<AbuseLimitName, number>;
const NAMES = Object.keys(ABUSE_LIMITS) as AbuseLimitName[];

/** The whole number the setting means, or null if it is not one that this setting can take. */
export function parseAbuseLimit(name: AbuseLimitName, value: unknown): number | null {
  const { min, max } = ABUSE_LIMITS[name];
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** Anything unset or unusable takes its default, so that a bad value cannot turn a limit off. `oc deploy` refuses one. */
export function readAbuseLimits(variables: object): AbuseLimits {
  const source = variables as Record<string, unknown>;
  return Object.fromEntries(NAMES.map((name) => [name, parseAbuseLimit(name, source[ABUSE_LIMITS[name].variable]) ?? ABUSE_LIMITS[name].default])) as AbuseLimits;
}

export const DEFAULT_ABUSE_LIMITS: AbuseLimits = readAbuseLimits({});
