import { useQuery } from '@tanstack/react-query';
import { api } from './app-context';

/** Shown until discovery answers, and if it cannot. */
const PROJECT = 'https://github.com/yatping/OpenChat';

/**
 * The source offer that the AGPL asks a server to make to its users, and the notices for the code bundled into
 * this page. The source is the one the operator set, or the project's at the deployed release. See
 * docs/operations/licensing.md.
 */
export function SoftwareFooter() {
  const discovery = useQuery({ queryKey: ['discovery'], queryFn: () => api.getDiscovery(), staleTime: Infinity, retry: false });
  const software = discovery.data?.software;
  return (
    <footer className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
      <span>OpenChat{software?.version ? ` ${software.version}` : ''}, free software under the AGPL</span>
      <a className="underline" href={software?.source ?? PROJECT} rel="noreferrer">
        Source code
      </a>
      <a className="underline" href="/third-party-licenses.txt">
        Third-party licences
      </a>
    </footer>
  );
}
