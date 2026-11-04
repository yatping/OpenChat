/**
 * `oc deploy` and `oc recover`. See docs/operations/deployment.md. Each step is recorded in state.json as it
 * finishes, so a failed run can be resumed. A resource name that already exists but is not recorded stops the
 * run, so that a deployment never adopts something it did not create.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { generateOpaqueToken, generateSerializedKey, hashOpaqueToken } from '@openchat/auth';
import { assertEmail, assertPublicUrl, bootstrapSql, recoverySql, resetLink } from './bootstrap';
import { formatChecks, hasFailure, isMissingWorkersDev, runPreflight, WORKERS_DEV_HELP } from './preflight';
import { renderConfig, type DeploymentState, mergeLimitFlags } from './render-config';

export interface State extends Omit<DeploymentState, 'd1DatabaseId'> {
  d1DatabaseId?: string;
  r2Created?: boolean;
  queuesCreated?: string[];
  deployed?: boolean;
  secretsSet?: boolean;
  initialized?: boolean;
  publicBaseUrl?: string;
}

export interface DeployOptions {
  name: string;
  ownerEmail?: string | undefined;
  ownerName?: string | undefined;
  workspaceName?: string | undefined;
  publicUrl?: string | undefined;
  location?: string | undefined;
  analytics?: boolean;
  emailFrom?: string | undefined;
  turnstileSiteKey?: string | undefined;
  cloudflareEmail?: boolean;
  limitFlag?: (name: string) => string | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDeployer(root: string) {
  const dirOf = (name: string) => join(root, '.openchat', name);
  const statePath = (name: string) => join(dirOf(name), 'state.json');
  const configPath = (name: string) => `../../.openchat/${name}/api.wrangler.jsonc`;

  /** Always the project's pinned Wrangler. Output is captured, so that it can be searched and kept quiet. */
  const wrangler = (args: string[], options: { input?: string; ci?: boolean } = {}): string =>
    execFileSync('pnpm', ['--filter', '@openchat/api', 'exec', 'wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.input === undefined ? {} : { input: options.input }),
      env: { ...process.env, ...(options.ci ? { CI: 'true' } : {}) },
    });

  const describeFailure = (error: unknown) => {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    return `${failure.stderr ?? ''}${failure.stdout ?? ''}` || failure.message;
  };

  const load = (name: string): State => (existsSync(statePath(name)) ? (JSON.parse(readFileSync(statePath(name), 'utf8')) as State) : { name });
  const save = (state: State) => {
    mkdirSync(dirOf(state.name), { recursive: true });
    writeFileSync(statePath(state.name), `${JSON.stringify(state, null, 2)}\n`);
  };

  /** The Queues API has returned an unexplained error 10013 for a valid request, so creation retries. */
  async function create(label: string, args: string[]): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return wrangler(args);
      } catch (error) {
        const detail = describeFailure(error);
        if (/already exists|already taken|11009|10026/i.test(detail)) {
          throw new Error(`${label} already exists, and this deployment did not create it. Choose another name.`, { cause: error });
        }
        if (attempt >= 4) throw new Error(`Could not create ${label}:\n${detail}`, { cause: error });
        await sleep(5000 * attempt);
      }
    }
  }

  function render(state: State) {
    if (!state.d1DatabaseId) throw new Error('The database has not been created yet');
    const serviceDir = join(root, 'services/api');
    const out = join(dirOf(state.name), 'api.wrangler.jsonc');
    const rendered = renderConfig(readFileSync(join(serviceDir, 'wrangler.template.jsonc'), 'utf8'), { ...state, d1DatabaseId: state.d1DatabaseId }, relative(dirname(out), serviceDir));
    writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`);
  }

  async function createResources(state: State, location: string | undefined) {
    const prefix = `oc-${state.name}`;
    if (!state.d1DatabaseId) {
      console.log(`Creating database ${prefix}`);
      const output = await create(`Database ${prefix}`, ['d1', 'create', prefix, ...(location ? ['--location', location] : [])]);
      const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(output)?.[0];
      if (!id) throw new Error('Could not find the new database ID');
      state.d1DatabaseId = id;
      save(state);
    }
    if (!state.r2Created) {
      console.log(`Creating bucket ${prefix}-attachments`);
      await create(`Bucket ${prefix}-attachments`, ['r2', 'bucket', 'create', `${prefix}-attachments`]);
      state.r2Created = true;
      save(state);
    }
    state.queuesCreated ??= [];
    for (const queue of ['notifications', 'email', 'jobs'].flatMap((q) => [`${prefix}-${q}-dlq`, `${prefix}-${q}`])) {
      if (state.queuesCreated.includes(queue)) continue;
      console.log(`Creating queue ${queue}`);
      await create(`Queue ${queue}`, ['queues', 'create', queue]);
      state.queuesCreated.push(queue);
      save(state);
    }
  }

  function buildAndDeploy(state: State) {
    console.log('Building');
    execFileSync('pnpm', ['build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('node', ['scripts/collect-assets.mjs'], { cwd: join(root, 'services/api'), stdio: 'inherit' });
    render(state);
    console.log('Applying migrations');
    wrangler(['d1', 'migrations', 'apply', `oc-${state.name}`, '--remote', '-c', configPath(state.name)], { ci: true });
    console.log('Deploying the Worker');
    let output: string;
    try {
      output = wrangler(['deploy', '-c', configPath(state.name)]);
    } catch (error) {
      if (isMissingWorkersDev(describeFailure(error))) throw new Error(WORKERS_DEV_HELP, { cause: error });
      throw error;
    }
    const url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
    if (url) state.publicBaseUrl ??= url;
    state.deployed = true;
    save(state);
    if (!state.publicBaseUrl) throw new Error('Could not find the deployed URL. Pass --public-url.');
  }

  /** Sent on stdin, so secrets touch neither the disk nor the process list. */
  const putSecrets = (state: State, secrets: Record<string, string>) => {
    wrangler(['secret', 'bulk', '-c', configPath(state.name)], { input: JSON.stringify(secrets) });
  };

  async function setSecrets(state: State, emailFrom: string | undefined) {
    if (!state.secretsSet) {
      // Only once: a new signing key would sign everyone out.
      console.log('Generating secrets');
      const active = await generateSerializedKey(`key-${Date.now().toString(36)}`);
      putSecrets(state, { AUTH_SIGNING_KEY: JSON.stringify({ active }) });
      state.secretsSet = true;
      save(state);
    }
    const resendKey = process.env.RESEND_API_KEY;
    if (state.cloudflareEmailFrom) {
      // Not secret, but set the same way as the Resend settings, so that switching needs no other change.
      putSecrets(state, { EMAIL_PROVIDER: 'cloudflare', SYSTEM_EMAIL_FROM: state.cloudflareEmailFrom });
      console.log('Configured Cloudflare Email Sending');
    } else if (resendKey) {
      if (!emailFrom) throw new Error('RESEND_API_KEY needs --email-from, an address on a domain verified with Resend');
      assertEmail(emailFrom);
      putSecrets(state, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: resendKey, SYSTEM_EMAIL_FROM: emailFrom });
      console.log('Configured Resend');
    }
  }

  async function initialize(state: State, options: DeployOptions): Promise<string | null> {
    if (state.initialized) return null;
    if (!options.ownerEmail) throw new Error('A first deploy needs --owner-email');
    const token = generateOpaqueToken();
    const sql = bootstrapSql({
      installationName: options.name,
      publicBaseUrl: state.publicBaseUrl!,
      ownerEmail: options.ownerEmail,
      ownerName: options.ownerName ?? 'Owner',
      workspaceName: options.workspaceName ?? 'My workspace',
      ownerTokenHash: await hashOpaqueToken(token),
    });
    console.log('Creating the first owner');
    wrangler(['d1', 'execute', `oc-${state.name}`, '--remote', '--yes', '-c', configPath(state.name), '--command', sql], { ci: true });
    state.initialized = true;
    save(state);
    return resetLink(state.publicBaseUrl!, token);
  }

  /** A 401 for made-up credentials proves the Worker, D1, the Durable Object, and the signing key all work. */
  async function verify(state: State) {
    const base = state.publicBaseUrl!;
    console.log('Verifying');
    let last = 'no answer';
    let loginFailing = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await sleep(5000);
      try {
        const health = await fetch(`${base}/health`);
        const discovery = await fetch(`${base}/.well-known/openchat.json`);
        const login = await fetch(`${base}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'deploy-check@example.invalid', password: 'not a real password', clientType: 'mobile' }),
        });
        last = `health ${health.status}, discovery ${discovery.status}, login ${login.status}`;
        loginFailing = login.status >= 500;
        // 429 counts too: the signing key loads before the limiter, and this address may just be busy.
        if (health.status === 200 && discovery.status === 200 && (login.status === 401 || login.status === 429)) return;
      } catch (error) {
        last = (error as Error).message;
      }
    }
    // On the Free plan, scrypt runs past the CPU limit, so the first sign of it is a login that errors.
    const hint = loginFailing ? '\nLogin is erroring. Check that this account is on Workers Paid: the Free plan cannot run password hashing.' : '';
    throw new Error(`The deployment did not become healthy: ${last}${hint}`);
  }

  /** Prints every check and returns false if any failed. Creates nothing. */
  function preflight(options: Pick<DeployOptions, 'analytics' | 'emailFrom' | 'publicUrl' | 'cloudflareEmail'>): boolean {
    const checks = runPreflight((args) => wrangler(args), {
      nodeVersion: process.version,
      accountIdFromEnv: process.env.CLOUDFLARE_ACCOUNT_ID,
      resendKey: Boolean(process.env.RESEND_API_KEY),
      ...(options.cloudflareEmail === undefined ? {} : { cloudflareEmail: options.cloudflareEmail }),
      ...(options.analytics === undefined ? {} : { analytics: options.analytics }),
      emailFrom: options.emailFrom,
      publicUrl: options.publicUrl,
    });
    console.log(formatChecks(checks));
    return !hasFailure(checks);
  }

  return {
    preflight,

    async deploy(options: DeployOptions) {
      if (options.publicUrl) assertPublicUrl(options.publicUrl);
      if (options.ownerEmail) assertEmail(options.ownerEmail);
      const state = load(options.name);
      if (options.limitFlag) state.limits = mergeLimitFlags(state.limits, options.limitFlag);
      if (!state.initialized && !options.ownerEmail) throw new Error('A first deploy needs --owner-email');
      if (options.analytics) state.analyticsEngine = true;
      if (options.publicUrl) state.publicBaseUrl = options.publicUrl;

      if (!preflight(options)) throw new Error('\nFix the items marked FAIL, then run this again. Nothing was created by this check.');
      if (options.cloudflareEmail) {
        assertEmail(options.emailFrom ?? '');
        state.cloudflareEmailFrom = options.emailFrom!;
      } else if (process.env.RESEND_API_KEY) {
        delete state.cloudflareEmailFrom;
      }
      await createResources(state, options.location);
      buildAndDeploy(state);
      await setSecrets(state, options.emailFrom);
      if (Boolean(process.env.TURNSTILE_SECRET_KEY) !== Boolean(options.turnstileSiteKey)) throw new Error('TURNSTILE_SECRET_KEY and --turnstile-site-key go together');
      if (options.turnstileSiteKey) putSecrets(state, { TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY!, TURNSTILE_SITE_KEY: options.turnstileSiteKey });
      const ownerLink = await initialize(state, options);
      await verify(state);

      console.log(`\nDeployed: ${state.publicBaseUrl}`);
      if (ownerLink) {
        console.log(`\nSet the owner's password within one hour. This link is shown only once:\n${ownerLink}`);
      }
      if (!process.env.RESEND_API_KEY && !state.cloudflareEmailFrom) {
        console.log('\nNo email provider was set in this run. Without one, resets and invitations are not delivered.');
        console.log(`Use --cloudflare-email, or RESEND_API_KEY, with --email-from, then deploy again. Until then: pnpm oc recover --env ${options.name} --email <address>`);
      }
    },

    /** Works with no email provider. Holding Cloudflare access is the proof of authority. */
    async recover(name: string, email: string) {
      assertEmail(email);
      const state = load(name);
      if (!state.initialized || !state.publicBaseUrl) throw new Error(`No initialised deployment named ${name} in .openchat`);
      render(state);
      const token = generateOpaqueToken();
      const output = wrangler(['d1', 'execute', `oc-${name}`, '--remote', '--yes', '--json', '-c', configPath(name), '--command', recoverySql(email, await hashOpaqueToken(token))], { ci: true });
      const changes = (JSON.parse(output) as { meta?: { changes?: number } }[])[0]?.meta?.changes ?? 0;
      if (changes !== 1) throw new Error(`No active account for ${email}`);
      console.log(`Set a new password within one hour. Using this link signs the account out everywhere:\n${resetLink(state.publicBaseUrl, token)}`);
    },
  };
}
