export const PASSWORD = 'a browser test password';
export const OWNER = { email: 'owner@example.com', name: 'Olive Owner', memberId: 'mem_owner' };
export const AGENT = { email: 'agent@example.com', name: 'Andy Agent', memberId: 'mem_agent' };
export const WORKSPACE_ID = 'work_e2e';
export const WEBSITE_KEY = 'key_e2e';
export const SITE_ORIGIN = 'https://shop.example';
export const STYLED_WEBSITE_KEY = 'key_e2e_styled';
export const STYLED_WEBSITE_SETTINGS = { welcomeMessage: 'Welcome to the shop', primaryColor: '#fde047', collectEmail: 'required', showAgentNames: true };
export const TURNSTILE_WEBSITE_KEY = 'key_e2e_turnstile';
/** Cloudflare's published test keys, which always pass. The local Worker really asks Cloudflare about them. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
