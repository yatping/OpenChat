import { describe, expect, it } from 'vitest';
import { PROJECT_REPOSITORY_URL, software } from './software';

describe('software', () => {
  it('points at the release when the operator set no source', () => {
    expect(software({ version: '0.3.0', sourceUrl: undefined })).toEqual({
      name: 'OpenChat',
      version: '0.3.0',
      license: 'AGPL-3.0-or-later',
      source: `${PROJECT_REPOSITORY_URL}/tree/v0.3.0`,
    });
  });

  it("prefers the operator's own source", () => {
    expect(software({ version: '0.3.0', sourceUrl: 'https://git.example.com/openchat' }).source).toBe('https://git.example.com/openchat');
  });

  it('falls back to the repository without a version', () => {
    expect(software({ version: undefined, sourceUrl: undefined })).toMatchObject({ version: null, source: PROJECT_REPOSITORY_URL });
  });

  it('ignores a malformed version or a source that is not https', () => {
    expect(software({ version: 'v1; drop', sourceUrl: 'http://git.example.com' })).toMatchObject({ version: null, source: PROJECT_REPOSITORY_URL });
  });
});
