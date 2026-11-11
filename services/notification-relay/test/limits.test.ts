import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIMIT_VARIABLES, limitsFor } from '../src/limits';

describe('reading limits', () => {
  it('uses the defaults when nothing is set', () => {
    expect(limitsFor({})).toEqual(DEFAULT_LIMITS);
  });

  it('reads numbers and numeric strings, and 0 as off', () => {
    expect(limitsFor({ RELAY_NOTIFICATIONS_PER_DAY: '50000', RELAY_DEVICES_PER_INSTALLATION: 0, RELAY_RECIPIENT_BURST: 10 })).toMatchObject({ notificationsPerDay: 50_000, devicesPerInstallation: 0, recipientBurst: 10 });
  });

  it('keeps the default for a value that is not a count, rather than turning the limit off', () => {
    for (const bad of ['', ' ', 'lots', '-1', 'Infinity', null, true]) expect(limitsFor({ RELAY_NOTIFICATIONS_PER_DAY: bad }).notificationsPerDay).toBe(DEFAULT_LIMITS.notificationsPerDay);
  });

  it('raises limits for one installation only, from a JSON string or an object', () => {
    const overrides = { inst_a: { notificationsPerDay: 100_000, devicesPerInstallation: 'x' } };
    for (const value of [JSON.stringify(overrides), overrides]) {
      const env = { RELAY_NOTIFICATIONS_PER_DAY: '20000', RELAY_LIMIT_OVERRIDES: value };
      expect(limitsFor(env, 'inst_a')).toMatchObject({ notificationsPerDay: 100_000, devicesPerInstallation: DEFAULT_LIMITS.devicesPerInstallation });
      expect(limitsFor(env, 'inst_b').notificationsPerDay).toBe(20_000);
    }
  });

  it('ignores overrides that are not a JSON object', () => {
    for (const value of ['{', '[1]', '"x"', 42]) expect(limitsFor({ RELAY_LIMIT_OVERRIDES: value }, 'inst_a')).toEqual(DEFAULT_LIMITS);
  });

  it('names a distinct variable for every limit', () => {
    expect(Object.keys(LIMIT_VARIABLES).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
    expect(new Set(Object.values(LIMIT_VARIABLES)).size).toBe(Object.keys(DEFAULT_LIMITS).length);
  });
});
