import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeLimitFlags, mergeSecurityFlags, mergeSourceFlag, parseTemplate, renderConfig } from '../src/render-config';

const source = readFileSync(new URL('../../../services/api/wrangler.template.jsonc', import.meta.url), 'utf8');
const state = { name: 'acme-prod', d1DatabaseId: '00000000-0000-0000-0000-000000000000' };

describe('renderConfig', () => {
  it('passes on only the limits the operator chose', () => {
    expect(renderConfig(source, state, '../../services/api').vars).toBeUndefined();
    const rendered = renderConfig(source, { ...state, limits: { messagesPerWebsitePerDay: 500 } }, '../../services/api');
    expect(rendered.vars).toEqual({ LIMIT_MESSAGES_PER_WEBSITE_PER_DAY: '500' });
  });

  it('keeps what a deployment chose until told otherwise, and refuses a value that cannot work', () => {
    const flags = (values: Record<string, string>) => (name: string) => values[name];
    const first = mergeLimitFlags(undefined, flags({ 'messages-per-website-per-day': '500', 'ipv6-prefix': '56' }));
    expect(first).toEqual({ messagesPerWebsitePerDay: 500, ipv6Prefix: 56 });
    expect(mergeLimitFlags(first, flags({ 'message-max-chars': '1000' }))).toEqual({ messagesPerWebsitePerDay: 500, ipv6Prefix: 56, messageMaxChars: 1000 });
    expect(mergeLimitFlags(first, flags({ 'ipv6-prefix': 'default' }))).toEqual({ messagesPerWebsitePerDay: 500 });
    expect(() => mergeLimitFlags(first, flags({ 'message-max-chars': '16001' }))).toThrow(/1 to 16000/);
    expect(() => mergeLimitFlags(first, flags({ 'ipv6-prefix': '16' }))).toThrow(/32 to 128/);
    expect(() => mergeLimitFlags(first, flags({ 'messages-per-ip-per-minute': 'lots' }))).toThrow(/whole number/);
  });

  it('adds the email binding only when chosen, restricted to the sending address', () => {
    expect(renderConfig(source, state, '../../services/api').send_email).toBeUndefined();
    expect(renderConfig(source, { ...state, cloudflareEmailFrom: 'no-reply@example.com' }, '../../services/api').send_email).toEqual([{ name: 'EMAIL', allowed_sender_addresses: ['no-reply@example.com'] }]);
  });

  const rendered = renderConfig(source, state, '../../services/api');

  it('prefixes every resource', () => {
    expect(rendered.name).toBe('oc-acme-prod');
    expect(rendered.d1_databases?.[0]).toMatchObject({ database_name: 'oc-acme-prod', database_id: state.d1DatabaseId });
    expect(rendered.r2_buckets?.[0]?.bucket_name).toBe('oc-acme-prod-attachments');
  });

  it('binds Analytics Engine only when the account has enabled it', () => {
    expect(rendered.analytics_engine_datasets).toBeUndefined();
    const enabled = renderConfig(source, { ...state, analyticsEngine: true }, '../../services/api');
    expect(enabled.analytics_engine_datasets?.[0]?.dataset).toBe('oc_acme_prod');
  });

  it('leaves no local resource names behind', () => {
    expect(JSON.stringify(rendered)).not.toMatch(/oc-local|oc_local/);
  });

  it('keeps every dead-letter queue attached', () => {
    const consumers = rendered.queues?.consumers ?? [];
    for (const consumer of consumers) if (!consumer.queue.endsWith('-dlq')) expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    expect(consumers).toHaveLength(6);
  });

  it('rebases paths relative to the rendered file', () => {
    expect(rendered.main).toBe('../../services/api/src/index.ts');
    expect(rendered.assets?.directory).toBe('../../services/api/.assets');
    expect(rendered.d1_databases?.[0]?.migrations_dir).toBe('../../services/api/../../packages/database/migrations');
  });

  it('renders a relay only for a deployment that chose one, and never its key', () => {
    expect((renderConfig(source, state, '.').vars as Record<string, string> | undefined)?.RELAY_URL).toBeUndefined();
    const rendered = renderConfig(source, { ...state, relay: { url: 'https://relay.example.org', id: 'managed', bundleIds: 'org.example.app' } }, '.');
    expect(rendered.vars).toMatchObject({ RELAY_URL: 'https://relay.example.org', RELAY_ID: 'managed', RELAY_BUNDLE_IDS: 'org.example.app' });
    expect(JSON.stringify(rendered)).not.toContain('RELAY_SIGNING_KEY');
  });

  it('does not change the template', () => {
    expect(parseTemplate(source).name).toBe('oc-local');
  });

  it.each(['Bad', 'has space', '../escape', '', '-leading'])('rejects the deployment name %j', (name) => {
    expect(() => renderConfig(source, { ...state, name }, '.')).toThrow();
  });

  it('rejects an invalid template', () => {
    expect(() => parseTemplate('{ nope')).toThrow();
  });
});

describe('security.txt settings', () => {
  it('render as Worker variables, and are absent by default', () => {
    const vars = (s: Parameters<typeof renderConfig>[1]) => renderConfig(source, s, '.').vars as Record<string, string> | undefined;
    expect(vars(state)?.SECURITY_CONTACT).toBeUndefined();
    expect(vars({ ...state, security: { contact: 'mailto:s@example.com', policy: 'https://example.com/p' } })).toMatchObject({ SECURITY_CONTACT: 'mailto:s@example.com', SECURITY_POLICY: 'https://example.com/p' });
  });

  it('are remembered, changed, and removed with none', () => {
    const set = mergeSecurityFlags(undefined, 'mailto:s@example.com', 'https://example.com/p');
    expect(set).toEqual({ contact: 'mailto:s@example.com', policy: 'https://example.com/p' });
    expect(mergeSecurityFlags(set, undefined, undefined)).toEqual(set);
    expect(mergeSecurityFlags(set, 'https://example.com/report', undefined)).toEqual({ contact: 'https://example.com/report', policy: 'https://example.com/p' });
    expect(mergeSecurityFlags({ ...set! }, undefined, 'none')).toEqual({ contact: 'mailto:s@example.com' });
    expect(mergeSecurityFlags(set, 'none', undefined)).toBeUndefined();
  });

  it('refuse what is not a contact or an https policy', () => {
    expect(() => mergeSecurityFlags(undefined, 'security@example.com', undefined)).toThrow(/mailto: addresses or https:\/\/ URLs/);
    expect(() => mergeSecurityFlags(undefined, 'mailto:s@example.com', 'http://example.com')).toThrow(/https:\/\/ URL/);
    expect(() => mergeSecurityFlags(undefined, undefined, 'https://example.com/p')).toThrow(/needs --security-contact/);
  });
});

describe('the source offer', () => {
  it('renders the release and the source URL as Worker variables', () => {
    expect(renderConfig(source, state, '.').vars ?? {}).not.toHaveProperty('OPENCHAT_VERSION');
    expect(renderConfig(source, { ...state, sourceUrl: 'https://git.example.com/ours' }, '.', '0.3.0').vars).toMatchObject({ OPENCHAT_VERSION: '0.3.0', SOURCE_URL: 'https://git.example.com/ours' });
  });

  it('remembers --source-url, removes it with none, and refuses what is not https', () => {
    expect(mergeSourceFlag(undefined, 'https://git.example.com/ours')).toBe('https://git.example.com/ours');
    expect(mergeSourceFlag('https://git.example.com/ours', undefined)).toBe('https://git.example.com/ours');
    expect(mergeSourceFlag('https://git.example.com/ours', 'none')).toBeUndefined();
    expect(() => mergeSourceFlag(undefined, 'git@example.com:ours.git')).toThrow(/https:\/\/ URL/);
  });
});
