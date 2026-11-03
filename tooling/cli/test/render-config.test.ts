import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTemplate, renderConfig } from '../src/render-config';

const source = readFileSync(new URL('../../../services/api/wrangler.template.jsonc', import.meta.url), 'utf8');
const state = { name: 'acme-prod', d1DatabaseId: '00000000-0000-0000-0000-000000000000' };

describe('renderConfig', () => {
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
