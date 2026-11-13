/**
 * What an installation says about the software it runs, in its discovery document. OpenChat's server is
 * AGPL-3.0-or-later, whose section 13 asks that users of a modified version be offered its source.
 * See docs/operations/licensing.md.
 */
import { isHttpsUrl } from './security-txt';

export const PROJECT_REPOSITORY_URL = 'https://github.com/yatping/OpenChat';
export const SERVER_LICENSE = 'AGPL-3.0-or-later';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Software {
  name: 'OpenChat';
  /** The release `oc deploy` deployed. Null for a Worker deployed some other way. */
  version: string | null;
  license: typeof SERVER_LICENSE;
  /** The operator's own source, if they set one, or the project's at that release. */
  source: string;
}

export function software(options: { version: string | undefined; sourceUrl: string | undefined }): Software {
  const version = options.version && VERSION.test(options.version) ? options.version : null;
  const source = options.sourceUrl && isHttpsUrl(options.sourceUrl) ? options.sourceUrl : version ? `${PROJECT_REPOSITORY_URL}/tree/v${version}` : PROJECT_REPOSITORY_URL;
  return { name: 'OpenChat', version, license: SERVER_LICENSE, source };
}
