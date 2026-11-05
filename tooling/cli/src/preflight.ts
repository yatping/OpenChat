/**
 * Checks what a Cloudflare account needs before `oc deploy` creates anything. Read-only. What Wrangler cannot
 * read, such as the plan, is listed as `confirm` rather than guessed. See docs/operations/deployment.md.
 */
export type CheckStatus = 'ok' | 'fail' | 'confirm' | 'note';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightOptions {
  nodeVersion: string;
  accountIdFromEnv?: string | undefined;
  analytics?: boolean;
  resendKey?: boolean;
  cloudflareEmail?: boolean;
  emailFrom?: string | undefined;
  publicUrl?: string | undefined;
}

export const REQUIRED_NODE_MAJOR = 24;

export const WORKERS_DEV_HELP =
  'Your account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard to choose one, then run the same command again. Resources already created are kept.';

const PLAN_HELP = 'Workers Paid is required, because password hashing needs more CPU than the Free plan allows. Check Workers & Pages > Plans in the Cloudflare dashboard.';

/** The reason from a failed command, without its progress output. */
function reason(error: unknown): string {
  const failure = error as { stderr?: string; stdout?: string; message?: string };
  const text = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim() || failure.message || 'unknown error';
  // eslint-disable-next-line no-control-regex -- Wrangler colours its errors.
  const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => /error|✘|\[code:/i.test(line)) ?? lines[0] ?? 'unknown error').replace(/^✘\s*(\[ERROR\]\s*)?/, '').slice(0, 300);
}

function canList(run: (args: string[]) => string, name: string, args: string[], help: string): Check {
  try {
    run(args);
    return { name, status: 'ok', detail: 'Available' };
  } catch (error) {
    return { name, status: 'fail', detail: `${reason(error)}\n${help}` };
  }
}

/** Null for any answer that isn't readable, since only a clear "logged in" counts. */
function readLogin(run: (args: string[]) => string): { loggedIn?: boolean; accounts?: { name?: string }[] } | null {
  try {
    const output = run(['whoami', '--json']);
    return JSON.parse(output.slice(output.indexOf('{'))) as { loggedIn?: boolean; accounts?: { name?: string }[] };
  } catch {
    return null;
  }
}

function checkCloudflareEmail(run: (args: string[]) => string, options: PreflightOptions): Check {
  const name = 'Email';
  if (options.resendKey) return { name, status: 'fail', detail: 'Choose one: RESEND_API_KEY or --cloudflare-email' };
  const domain = options.emailFrom?.split('@')[1];
  if (!domain) return { name, status: 'fail', detail: '--cloudflare-email needs --email-from, an address on a domain onboarded for Email Sending' };
  const enable = `Onboard it with: pnpm --filter @openchat/api exec wrangler email sending enable ${domain}`;
  try {
    const output = run(['email', 'sending', 'list', domain]);
    if (output.toLowerCase().includes(domain.toLowerCase())) return { name, status: 'ok', detail: `Cloudflare Email Sending is set up for ${domain}` };
    return { name, status: 'fail', detail: `Email Sending is not set up for ${domain}. ${enable}` };
  } catch (error) {
    const detail = reason(error);
    if (/\[code: 10000\]|authentication error/i.test(`${detail} ${(error as { stderr?: string }).stderr ?? ''}`)) {
      return { name, status: 'fail', detail: 'This login cannot manage Email Sending. Run again: pnpm --filter @openchat/api exec wrangler login. An API token needs Email Sending edit permission' };
    }
    return { name, status: 'fail', detail: `${detail}\nThe domain must use Cloudflare DNS in this account. ${enable}` };
  }
}

/** `run` calls the project's Wrangler and throws when it exits with an error. */
export function runPreflight(run: (args: string[]) => string, options: PreflightOptions): Check[] {
  const checks: Check[] = [];

  const major = Number(/^v?(\d+)/.exec(options.nodeVersion)?.[1]);
  checks.push(
    major >= REQUIRED_NODE_MAJOR
      ? { name: 'Node.js', status: 'ok', detail: options.nodeVersion }
      : { name: 'Node.js', status: 'fail', detail: `${options.nodeVersion} is too old. Install Node ${REQUIRED_NODE_MAJOR} or newer` },
  );

  const who = readLogin(run);
  if (!who?.loggedIn) {
    checks.push({ name: 'Cloudflare login', status: 'fail', detail: 'Not logged in. Run: pnpm --filter @openchat/api exec wrangler login, or set CLOUDFLARE_API_TOKEN' });
    return checks; // Everything after this would fail for the same reason.
  }
  checks.push({ name: 'Cloudflare login', status: 'ok', detail: 'Logged in' });

  const accounts = who.accounts ?? [];
  if (options.accountIdFromEnv) {
    checks.push({ name: 'Cloudflare account', status: 'ok', detail: 'Chosen by CLOUDFLARE_ACCOUNT_ID' });
  } else if (accounts.length === 1) {
    checks.push({ name: 'Cloudflare account', status: 'ok', detail: accounts[0]?.name ?? 'One account' });
  } else if (accounts.length > 1) {
    checks.push({ name: 'Cloudflare account', status: 'fail', detail: `This login can reach ${accounts.length} accounts: ${accounts.map((a) => a.name).join(', ')}. Set CLOUDFLARE_ACCOUNT_ID to choose one` });
    return checks; // Wrangler refuses to guess, so the listings below would fail with a less useful message.
  } else {
    checks.push({ name: 'Cloudflare account', status: 'fail', detail: 'This login can see no accounts. Set CLOUDFLARE_ACCOUNT_ID, or use a token with account access' });
    return checks;
  }

  const permissions = 'If you use an API token, it needs Workers Scripts, D1, R2, and Queues edit permissions.';
  checks.push(canList(run, 'D1', ['d1', 'list', '--json'], permissions));
  checks.push(canList(run, 'R2', ['r2', 'bucket', 'list'], `A new account must add R2 once, under Storage & databases > R2 in the Cloudflare dashboard. ${permissions}`));
  checks.push(canList(run, 'Queues', ['queues', 'list'], permissions));

  checks.push({ name: 'Workers Paid plan', status: 'confirm', detail: `Wrangler cannot read the plan. ${PLAN_HELP}` });
  checks.push({ name: 'workers.dev subdomain', status: 'confirm', detail: 'Wrangler cannot read this without deploying. A new account may need to choose one under Workers & Pages. The deploy stops and says so if it is missing' });

  if (options.analytics) {
    checks.push({ name: 'Analytics Engine', status: 'confirm', detail: '--analytics needs Analytics Engine enabled once in the Cloudflare dashboard, or the deploy fails' });
  }
  if (options.publicUrl) {
    checks.push({ name: 'Custom domain', status: 'confirm', detail: `Attach ${options.publicUrl} to the Worker yourself. The zone must be on Cloudflare` });
  }

  if (options.cloudflareEmail) {
    checks.push(checkCloudflareEmail(run, options));
  } else if (options.resendKey && !options.emailFrom) {
    checks.push({ name: 'Email', status: 'fail', detail: 'RESEND_API_KEY needs --email-from, an address on a domain verified with Resend' });
  } else if (options.resendKey) {
    checks.push({ name: 'Email', status: 'confirm', detail: `Resend is not contacted here. Confirm that the domain of ${options.emailFrom} is verified with Resend` });
  } else {
    checks.push({ name: 'Email', status: 'note', detail: 'None set. New account links and resets are not delivered. Use pnpm oc recover until one is set' });
  }
  return checks;
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok     ', fail: 'FAIL   ', confirm: 'confirm', note: 'note   ' };

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${LABEL[c.status]} ${c.name}: ${c.detail.replace(/\n/g, '\n        ')}`).join('\n');
}

export const hasFailure = (checks: Check[]) => checks.some((c) => c.status === 'fail');

/** Wrangler's own wording for a missing subdomain, in wrangler-dist/cli.js at 4.157. */
export const isMissingWorkersDev = (detail: string) => /workers\.dev subdomain/i.test(detail);
