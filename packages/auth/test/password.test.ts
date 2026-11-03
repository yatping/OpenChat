import { describe, expect, it } from 'vitest';
import { CURRENT_PARAMS, hashPassword, MAX_PASSWORD_LENGTH, needsRehash, verifyAgainstDummy, verifyPassword } from '../src/index';

// Real parameters only where cost is the point. Cheap ones keep the rest of the suite fast.
const FAST = { N: 2 ** 4, r: 8, p: 1 };

describe('hashPassword', () => {
  it('uses the agreed parameters by default, and stores them with the hash', async () => {
    expect(CURRENT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$32768\$8\$3\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('wrong horse battery', stored)).toBe(false);
  });

  it('salts, so one password gives different hashes', async () => {
    expect(await hashPassword('same password', FAST)).not.toBe(await hashPassword('same password', FAST));
  });

  it('never contains the password', async () => {
    expect(await hashPassword('findable-secret', FAST)).not.toContain('findable-secret');
  });

  it('refuses an oversized password before doing any work', async () => {
    await expect(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), FAST)).rejects.toThrow(RangeError);
  });

  it('treats equivalent Unicode forms as one password', async () => {
    const stored = await hashPassword('café-password', FAST);
    expect(await verifyPassword('café-password', stored)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('honours the parameters stored with an older hash', async () => {
    const stored = await hashPassword('older password', FAST);
    expect(await verifyPassword('older password', stored)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['another scheme', 'bcrypt$2$x$y$z$w'],
    ['too few fields', 'scrypt$16$8$1$abc'],
    ['N not a power of two', 'scrypt$15$8$1$AAAA$AAAA'],
    ['zero N', 'scrypt$0$8$1$AAAA$AAAA'],
    ['negative r', 'scrypt$16$-8$1$AAAA$AAAA'],
    ['huge N, which would exhaust memory', 'scrypt$1073741824$8$1$AAAA$AAAA'],
    ['huge p', 'scrypt$16$8$1000000$AAAA$AAAA'],
    ['non-numeric', 'scrypt$a$b$c$AAAA$AAAA'],
    ['bad salt encoding', 'scrypt$16$8$1$!!!$AAAA'],
    ['empty key', 'scrypt$16$8$1$AAAA$'],
  ])('returns false, without throwing, for a malformed hash: %s', async (_name, stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false);
  });

  it('returns false for an oversized password', async () => {
    expect(await verifyPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), await hashPassword('short', FAST))).toBe(false);
  });
});

describe('needsRehash', () => {
  it('asks for older parameters to be replaced', async () => {
    expect(needsRehash(await hashPassword('p', FAST))).toBe(true);
    expect(needsRehash(await hashPassword('p'))).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('verifyAgainstDummy', () => {
  // Only the result is checked here, because workerd's clocks stop during CPU work. Whether login timing
  // really matches has to be measured from outside on a deployment, with the login route in Milestone 1a.
  it('always fails', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false);
    expect(await verifyAgainstDummy('')).toBe(false);
  });
});
