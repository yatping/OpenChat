/**
 * Renders a Worker's committed template into a deployment's own config. Wrangler can write generated
 * IDs back into its config, which would dirty a checkout, so real IDs live in .openchat/<env>/ instead.
 * See docs/operations/deployment.md.
 */
import { ABUSE_LIMITS, type AbuseLimitName, type AbuseLimits, parseAbuseLimit } from '@openchat/shared';
import { parse, type ParseError } from 'jsonc-parser';

export interface DeploymentState {
  /** Short deployment name, used as a prefix for every resource. */
  name: string;
  d1DatabaseId: string;
  /** Set only after `oc restore` moved the deployment to a new database. Otherwise oc-<name>. */
  d1DatabaseName?: string | undefined;
  /**
   * Analytics Engine must be enabled once per account in the Cloudflare dashboard, and a deploy that
   * binds it fails until then. So it is opt-in, and the Worker treats the binding as optional.
   */
  analyticsEngine?: boolean;
  /** The sending address, for a deployment using Cloudflare Email Service. The binding can send from nothing else. */
  cloudflareEmailFrom?: string;
  /** Only what the operator chose. Anything left out takes its default in the Worker. */
  limits?: Partial<AbuseLimits> | undefined;
  /** Push is opt-in until a managed relay exists. Its signing key is a secret, set separately. */
  relay?: { url: string; id: string; bundleIds: string } | undefined;
}

interface Template {
  name: string;
  main: string;
  assets?: { directory: string };
  d1_databases?: { binding: string; database_name: string; database_id: string; migrations_dir?: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: { queue: string; dead_letter_queue?: string }[];
  };
  analytics_engine_datasets?: { binding: string; dataset: string }[];
  [key: string]: unknown;
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Applies what `flag` finds to what the deployment already chose, which is kept for later deploys. The word
 * `default` goes back to the default. A value outside what a setting can take stops the deploy.
 */
export function mergeLimitFlags(current: Partial<AbuseLimits> | undefined, flag: (name: string) => string | undefined): Partial<AbuseLimits> {
  const merged = { ...current };
  for (const name of Object.keys(ABUSE_LIMITS) as AbuseLimitName[]) {
    const setting = ABUSE_LIMITS[name];
    const value = flag(setting.flag);
    if (value === undefined) continue;
    if (value === 'default') {
      delete merged[name];
      continue;
    }
    const parsed = parseAbuseLimit(name, value);
    if (parsed === null) throw new Error(`--${setting.flag} must be a whole number from ${setting.min} to ${setting.max}, or "default"`);
    merged[name] = parsed;
  }
  return merged;
}

export function parseTemplate(source: string): Template {
  const errors: ParseError[] = [];
  const template = parse(source, errors, { allowTrailingComma: true }) as Template;
  if (errors.length > 0) throw new Error(`Invalid template: ${errors.length} parse error(s)`);
  return template;
}

const renameResource = (value: string, name: string) => value.replace(/^oc-local/, `oc-${name}`);

/** `relativeRoot` is the path from the rendered file back to the Worker's directory. */
export function renderConfig(templateSource: string, state: DeploymentState, relativeRoot: string): Template {
  if (!NAME.test(state.name)) throw new Error('Deployment names must be lowercase letters, numbers, and hyphens');
  const t = structuredClone(parseTemplate(templateSource));
  const rebase = (path: string) => `${relativeRoot}/${path.replace(/^\.\//, '')}`;

  t.name = `oc-${state.name}`;
  t.main = rebase(t.main);
  delete t.$schema;
  if (t.assets) t.assets.directory = rebase(t.assets.directory);
  for (const db of t.d1_databases ?? []) {
    db.database_name = state.d1DatabaseName ?? renameResource(db.database_name, state.name);
    db.database_id = state.d1DatabaseId;
    if (db.migrations_dir) db.migrations_dir = rebase(db.migrations_dir);
  }
  for (const bucket of t.r2_buckets ?? []) bucket.bucket_name = renameResource(bucket.bucket_name, state.name);
  for (const producer of t.queues?.producers ?? []) producer.queue = renameResource(producer.queue, state.name);
  for (const consumer of t.queues?.consumers ?? []) {
    consumer.queue = renameResource(consumer.queue, state.name);
    if (consumer.dead_letter_queue) consumer.dead_letter_queue = renameResource(consumer.dead_letter_queue, state.name);
  }
  if (state.analyticsEngine) {
    for (const dataset of t.analytics_engine_datasets ?? []) dataset.dataset = dataset.dataset.replace(/^oc_local/, `oc_${state.name.replaceAll('-', '_')}`);
  } else {
    delete t.analytics_engine_datasets;
  }
  const limits = Object.entries(state.limits ?? {}).map(([name, value]) => [ABUSE_LIMITS[name as AbuseLimitName].variable, String(value)]);
  if (limits.length > 0) t.vars = { ...(t.vars as object | undefined), ...Object.fromEntries(limits) };
  if (state.relay) t.vars = { ...(t.vars as object | undefined), RELAY_URL: state.relay.url, RELAY_ID: state.relay.id, RELAY_BUNDLE_IDS: state.relay.bundleIds };
  if (state.cloudflareEmailFrom) t.send_email = [{ name: 'EMAIL', allowed_sender_addresses: [state.cloudflareEmailFrom] }];
  return t;
}
