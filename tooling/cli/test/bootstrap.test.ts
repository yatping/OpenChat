import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertEmail, assertPublicUrl, bootstrapSql, recoverySql, resetLink } from '../src/bootstrap';

const migrations = join(import.meta.dirname, '../../../packages/database/migrations');
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrations, file), 'utf8').replaceAll('--> statement-breakpoint', ''));
  }
});

const input = {
  installationName: 'Acme',
  publicBaseUrl: 'https://chat.example.com',
  ownerEmail: 'owner@example.com',
  ownerName: 'The Owner',
  workspaceName: 'Support team',
  ownerTokenHash: 'hash-1',
};

describe('bootstrapSql', () => {
  it('creates an installation, owner, workspace, and a token against the real schema', () => {
    db.exec(bootstrapSql(input));
    expect(db.prepare('SELECT name, public_base_url AS url, signup_policy AS policy FROM installation').get()).toEqual({ name: 'Acme', url: 'https://chat.example.com', policy: 'invite_only' });
    expect(db.prepare('SELECT email, password_hash AS hash FROM users').get()).toEqual({ email: 'owner@example.com', hash: '!' });
    const member = db.prepare('SELECT m.role, m.status, w.name, w.slug FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id').get() as { role: string; status: string; name: string; slug: string };
    expect(member).toMatchObject({ role: 'supervisor', status: 'active', name: 'Support team' });
    expect(member.slug).toMatch(/^support-team-[a-z0-9]{8}$/);
    const token = db.prepare('SELECT purpose, expires_at AS e FROM auth_tokens WHERE token_hash = ?').get('hash-1') as { purpose: string; e: number };
    expect(token.purpose).toBe('password_reset');
    expect(token.e).toBeGreaterThan(Date.now());
  });

  it('adds nothing when the installation already exists, so a repeat cannot create a second owner', () => {
    db.exec(bootstrapSql(input));
    db.exec(bootstrapSql({ ...input, ownerEmail: 'attacker@example.com', ownerTokenHash: 'hash-2' }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get()).toEqual({ n: 1 });
  });

  it('quotes names, so that they cannot change the SQL', () => {
    const name = `O'Brien'); DROP TABLE users; --`;
    db.exec(bootstrapSql({ ...input, ownerName: name, workspaceName: `Bob's "team"` }));
    expect(db.prepare('SELECT name FROM users').get()).toEqual({ name });
    expect(db.prepare('SELECT name FROM workspaces').get()).toEqual({ name: `Bob's "team"` });
  });

  it.each([
    ['a control character in a name', { ownerName: 'a\nb' }],
    ['an empty name', { workspaceName: ' ' }],
    ['a quote in an email address', { ownerEmail: `x'@example.com` }],
    ['plain HTTP', { publicBaseUrl: 'http://chat.example.com' }],
  ])('refuses %s', (_label, change) => {
    expect(() => bootstrapSql({ ...input, ...change })).toThrow();
  });
});

describe('recoverySql', () => {
  beforeEach(() => db.exec(bootstrapSql(input)));
  const changes = (sql: string) => db.prepare(sql).run().changes;

  it('issues a token for an active account, whatever the case of the address', () => {
    expect(changes(recoverySql('OWNER@example.com', 'hash-2'))).toBe(1);
  });

  it('issues nothing for an unknown or disabled account', () => {
    expect(changes(recoverySql('nobody@example.com', 'hash-2'))).toBe(0);
    db.exec('UPDATE users SET disabled_at = 1');
    expect(changes(recoverySql('owner@example.com', 'hash-3'))).toBe(0);
  });
});

describe('validation', () => {
  it('accepts ordinary values', () => {
    expect(() => assertEmail('a.b+c@example.co.uk')).not.toThrow();
    expect(() => assertPublicUrl('https://chat.example.com')).not.toThrow();
  });

  it.each(['https://chat.example.com/', 'https://chat.example.com/path', 'nonsense'])('refuses the public URL %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it('puts the token in the fragment, which browsers do not send to servers', () => {
    expect(resetLink('https://x.test', 'abc')).toBe('https://x.test/reset-password#token=abc');
  });
});
