/**
 * The embeddable loader. Deliberately has no dependencies: the budget is 5 KB gzipped, and the chat UI
 * loads lazily behind it in Milestone 1b. Contracts may be imported as types only.
 */
import type { DiscoveryResponseShape } from './types';

declare global {
  interface Window {
    OpenChatConfig?: { websiteKey?: string; apiUrl?: string };
  }
}

function mount(): void {
  const host = document.createElement('div');
  host.id = 'openchat-widget';
  // Shadow DOM isolates styles in both directions.
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>:host{all:initial}</style>';
  document.body.appendChild(host);
}

export type { DiscoveryResponseShape };

if (window.OpenChatConfig?.websiteKey) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
