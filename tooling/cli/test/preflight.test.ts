import { describe, expect, it } from 'vitest';
import { formatChecks, hasFailure, isMissingWorkersDev, runPreflight, type Check } from '../src/preflight';

const ONE_ACCOUNT = JSON.stringify({ loggedIn: true, accounts: [{ name: 'Acme' }] });
const base = { nodeVersion: 'v24.18.0' };

/** Answers like Wrangler. A value that is an Error is thrown, as execFileSync does on a non-zero exit. */
const wrangler = (answers: Record<string, string | Error> = {}) => {
  const calls: string[] = [];
  const run = (args: string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key] ?? (key === 'whoami --json' ? ONE_ACCOUNT : '');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
};
const failure = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });
const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe('runPreflight', () => {
  it('passes a ready account, and only ever reads', () => {
    const { run, calls } = wrangler();
    const checks = runPreflight(run, base);
    expect(hasFailure(checks)).toBe(false);
    expect(calls).toEqual(['whoami --json', 'd1 list --json', 'r2 bucket list', 'queues list']);
  });

  it('never claims what it cannot see', () => {
    const checks = runPreflight(wrangler().run, base);
    expect(find(checks, 'Workers Paid plan')?.status).toBe('confirm');
    expect(find(checks, 'workers.dev subdomain')?.status).toBe('confirm');
  });

  it('stops at the login when there is none', () => {
    const { run, calls } = wrangler({ 'whoami --json': failure('Not logged in') });
    const checks = runPreflight(run, base);
    expect(find(checks, 'Cloudflare login')?.status).toBe('fail');
    expect(calls).toEqual(['whoami --json']);
  });

  it('treats unreadable or logged-out answers as no login', () => {
    for (const answer of ['not json', JSON.stringify({ loggedIn: false })]) {
      expect(find(runPreflight(wrangler({ 'whoami --json': answer }).run, base), 'Cloudflare login')?.status).toBe('fail');
    }
  });

  it('asks which account when there are several, unless one is chosen', () => {
    const several = JSON.stringify({ loggedIn: true, accounts: [{ name: 'A' }, { name: 'B' }] });
    const refused = runPreflight(wrangler({ 'whoami --json': several }).run, base);
    expect(find(refused, 'Cloudflare account')).toMatchObject({ status: 'fail', detail: expect.stringContaining('CLOUDFLARE_ACCOUNT_ID') });
    expect(hasFailure(runPreflight(wrangler({ 'whoami --json': several }).run, { ...base, accountIdFromEnv: 'abc' }))).toBe(false);
  });

  it('explains R2 when it has not been added, and keeps the reason', () => {
    const coloured = '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m A request failed [code: 10042]';
    const checks = runPreflight(wrangler({ 'r2 bucket list': failure(coloured) }).run, base);
    const r2 = find(checks, 'R2');
    expect(r2?.status).toBe('fail');
    expect(r2?.detail).toContain('[code: 10042]');
    expect(r2?.detail).not.toContain('\u001b');
    expect(r2?.detail).toContain('Storage & databases > R2');
    expect(find(checks, 'D1')?.status).toBe('ok');
  });

  it('reports every failing service in one run', () => {
    const checks = runPreflight(wrangler({ 'd1 list --json': failure('denied'), 'queues list': failure('denied') }).run, base);
    expect(checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(['D1', 'Queues']);
  });

  it('refuses an old Node', () => {
    expect(find(runPreflight(wrangler().run, { nodeVersion: 'v22.11.0' }), 'Node.js')?.status).toBe('fail');
    expect(find(runPreflight(wrangler().run, { nodeVersion: 'v25.0.0' }), 'Node.js')?.status).toBe('ok');
  });

  it('catches a Resend key with no sender before anything is created', () => {
    expect(find(runPreflight(wrangler().run, { ...base, resendKey: true }), 'Email')?.status).toBe('fail');
    expect(find(runPreflight(wrangler().run, { ...base, resendKey: true, emailFrom: 'a@b.example' }), 'Email')?.status).toBe('confirm');
    expect(find(runPreflight(wrangler().run, base), 'Email')?.status).toBe('note');
  });

  describe('Cloudflare email', () => {
    const options = { ...base, cloudflareEmail: true, emailFrom: 'no-reply@holfun.example' };
    const list = 'email sending list holfun.example';

    it('passes when the domain is onboarded', () => {
      expect(find(runPreflight(wrangler({ [list]: 'holfun.example  enabled' }).run, options), 'Email')?.status).toBe('ok');
    });

    it('says how to onboard a domain that is not', () => {
      const email = find(runPreflight(wrangler({ [list]: 'No sending subdomains found in this account.' }).run, options), 'Email');
      expect(email).toMatchObject({ status: 'fail', detail: expect.stringContaining('wrangler email sending enable holfun.example') });
    });

    it('explains a login without the email permission', () => {
      const email = find(runPreflight(wrangler({ [list]: failure('A request failed.\n  Authentication error [code: 10000]') }).run, options), 'Email');
      expect(email).toMatchObject({ status: 'fail', detail: expect.stringContaining('wrangler login') });
    });

    it('needs a sender, and refuses two providers', () => {
      expect(find(runPreflight(wrangler().run, { ...base, cloudflareEmail: true }), 'Email')?.status).toBe('fail');
      expect(find(runPreflight(wrangler().run, { ...options, resendKey: true }), 'Email')?.status).toBe('fail');
    });
  });

  it('lists the optional items only when asked for', () => {
    expect(find(runPreflight(wrangler().run, base), 'Analytics Engine')).toBeUndefined();
    expect(find(runPreflight(wrangler().run, { ...base, analytics: true }), 'Analytics Engine')?.status).toBe('confirm');
    expect(find(runPreflight(wrangler().run, { ...base, publicUrl: 'https://chat.example.com' }), 'Custom domain')?.status).toBe('confirm');
  });

  it('prints one line per check', () => {
    expect(formatChecks([{ name: 'R2', status: 'fail', detail: 'one\ntwo' }])).toBe('FAIL    R2: one\n        two');
  });
});

describe('isMissingWorkersDev', () => {
  it("matches Wrangler's wording", () => {
    expect(isMissingWorkersDev('You can either deploy your worker to one or more routes, or register a workers.dev subdomain here:')).toBe(true);
    expect(isMissingWorkersDev('Some other deploy failure')).toBe(false);
  });
});
