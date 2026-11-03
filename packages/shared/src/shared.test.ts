import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AppError,
  createLogger,
  encodeBase32,
  fromIso,
  isId,
  newId,
  retryDelaySeconds,
  toIso,
  toProblem,
  uuidv7Bytes,
  versionConflict,
  type LogFields,
} from './index';

describe('ids', () => {
  it('has the documented shape', () => {
    expect(newId('conversation')).toMatch(/^conv_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId('conversation', newId('conversation'))).toBe(true);
    expect(isId('message', newId('conversation'))).toBe(false);
    expect(isId('conversation', 'conv_short')).toBe(false);
  });

  it('sets UUIDv7 version and variant, and encodes the timestamp big-endian', () => {
    const bytes = uuidv7Bytes(0x0190_1234_5678);
    expect(bytes[6]! >> 4).toBe(7);
    expect(bytes[8]! >> 6).toBe(2);
    expect([...bytes.slice(0, 6)]).toEqual([0x01, 0x90, 0x12, 0x34, 0x56, 0x78]);
  });

  it('keeps timestamps above 32 bits intact', () => {
    const now = Date.UTC(2099, 0, 1);
    const bytes = uuidv7Bytes(now);
    let decoded = 0;
    for (let i = 0; i < 6; i++) decoded = decoded * 256 + bytes[i]!;
    expect(decoded).toBe(now);
  });

  it('sorts by creation time as a string', () => {
    const times = [1, 1_000, 1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000, 4_000_000_000_000];
    const ids = times.map((t) => newId('message', t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('encodes known values', () => {
    expect(encodeBase32(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(encodeBase32(new Uint8Array(16).fill(255))).toBe('7' + 'Z'.repeat(25));
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('message', 1_700_000_000_000)));
    expect(ids.size).toBe(5000);
  });
});

describe('problem details', () => {
  it('exposes application errors', () => {
    expect(toProblem(versionConflict(7), 'req_1')).toEqual({
      type: 'urn:openchat:error:version_conflict',
      title: 'The resource was changed by someone else',
      status: 409,
      code: 'version_conflict',
      requestId: 'req_1',
      details: { currentVersion: 7 },
    });
    expect(new AppError(404, 'not_found', 'x').status).toBe(404);
  });

  it('never echoes an unexpected error message', () => {
    const problem = toProblem(new Error('SELECT secret FROM users WHERE email = a@b.c'), 'req_1');
    expect(JSON.stringify(problem)).not.toContain('secret');
    expect(problem.status).toBe(500);
  });
});

describe('logger', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return { lines, sink: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) };
  };

  it('writes JSON with base and call fields', () => {
    const { lines, sink } = capture();
    createLogger({ requestId: 'r' }, sink).child({ route: '/x' }).info('hello', { status: 200 });
    expect(lines[0]).toMatchObject({ level: 'info', event: 'hello', requestId: 'r', route: '/x', status: 200 });
  });

  it('drops fields outside the allowlist at runtime', () => {
    const { lines, sink } = capture();
    const unsafe = { requestId: 'r', password: 'hunter2', content: 'private message', email: 'a@b.c' };
    createLogger({}, sink).info('x', unsafe as LogFields);
    expect(JSON.stringify(lines[0])).not.toMatch(/hunter2|private message|a@b\.c/);
    expect(lines[0]).toMatchObject({ requestId: 'r' });
  });

  it('rejects fields outside the allowlist at compile time', () => {
    // @ts-expect-error password is not a loggable field
    const invalid: LogFields = { password: 'hunter2' };
    expect(invalid).toBeDefined();
    expectTypeOf<LogFields>().not.toHaveProperty('email');
    expectTypeOf<LogFields>().not.toHaveProperty('content');
  });
});

describe('time', () => {
  it('round-trips in UTC', () => {
    expect(toIso(fromIso('2026-11-03T10:00:00.000Z'))).toBe('2026-11-03T10:00:00.000Z');
    expect(fromIso('2026-11-03T18:00:00+08:00')).toBe(fromIso('2026-11-03T10:00:00Z'));
    expect(() => fromIso('nonsense')).toThrow(RangeError);
  });
});

describe('retry backoff', () => {
  it('grows exponentially and caps at an hour plus jitter', () => {
    expect(retryDelaySeconds(0, () => 0.5)).toBe(5);
    expect(retryDelaySeconds(3, () => 0.5)).toBe(40);
    expect(retryDelaySeconds(30, () => 0.5)).toBe(3600);
    expect(retryDelaySeconds(30, () => 1)).toBe(4320);
    expect(retryDelaySeconds(30, () => 0)).toBe(2880);
  });
});
