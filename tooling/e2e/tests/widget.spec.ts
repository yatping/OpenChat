/**
 * The real widget on a page from another origin, against the real Worker. The page is served by the browser
 * test itself under the address the website allows, so CORS and the Origin checks all run for real.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { OWNER, SITE_ORIGIN, STYLED_WEBSITE_KEY, TURNSTILE_WEBSITE_KEY, WEBSITE_KEY } from './fixtures';
import { nextIp, signIn } from './helpers';

const NONCE = 'test-nonce';
const HOSTILE_CSS = 'button,div,p,textarea{display:none!important;color:red!important} *{font-size:99px!important}';

type HostOptions = { consent?: boolean; csp?: boolean; latin1?: boolean; origin?: string; lang?: string; locale?: string };

function hostHtml(key: string, options: HostOptions = {}) {
  return `<!doctype html><html${options.lang === '' ? '' : ` lang="${options.lang ?? 'en'}"`}><head><meta charset="${options.latin1 ? 'iso-8859-1' : 'utf-8'}"><title>Shop</title>
    ${options.csp ? '' : `<style>${HOSTILE_CSS}</style>`}</head>
    <body><h1>A customer's shop</h1>
    <script src="${BASE_URL}/widget/widget.js" data-website-key="${key}" ${options.locale ? `data-locale="${options.locale}"` : ''} ${options.consent ? 'data-consent="pending"' : ''} ${options.csp ? `nonce="${NONCE}"` : ''} async></script>
    </body></html>`;
}

async function visitorContext(browser: Browser, viewport?: { width: number; height: number }, locale?: string) {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), ...(locale ? { locale } : {}), extraHTTPHeaders: { 'cf-connecting-ip': nextIp() } });
  return context;
}

async function shop(context: BrowserContext, key = WEBSITE_KEY, options: HostOptions = {}) {
  const origin = options.origin ?? SITE_ORIGIN;
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: hostHtml(key, options),
      headers: options.csp ? { 'content-security-policy': `default-src 'none'; script-src 'nonce-${NONCE}' ${BASE_URL}; connect-src ${BASE_URL} ${BASE_URL.replace('http', 'ws')}; style-src 'none'; base-uri 'none'` } : {},
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  return page;
}

const launcher = (page: Page) => page.locator('#openchat-widget .oc-launcher');
const panel = (page: Page) => page.getByRole('dialog', { name: 'Chat' });
const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const compose = (page: Page) => page.getByRole('textbox', { name: 'Your message' });

async function say(page: Page, text: string) {
  await compose(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Starts a conversation through the widget, and gives its ID. */
async function startChat(page: Page, first: string) {
  await launcher(page).click();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/widget/conversations') && r.request().method() === 'POST');
  await say(page, first);
  const { id } = (await (await created).json()) as { id: string };
  await expect(log(page).getByText(first)).toBeVisible();
  return id;
}

const inboxRow = (agent: Page, conversationId: string) => agent.getByRole('button', { name: new RegExp(`Visitor ${conversationId.slice(-6)}`) });

async function reply(agent: Page, text: string) {
  await agent.getByLabel('Reply').fill(text);
  await agent.getByRole('button', { name: 'Send reply' }).click();
  await expect(agent.getByRole('list', { name: 'Messages' })).toContainText(text);
}

async function openInbox(browser: Browser) {
  const context = await browser.newContext();
  const agent = await context.newPage();
  await signIn(agent, OWNER);
  return agent;
}

/** Stands between the widget and its socket. */
async function controlSocket(context: BrowserContext) {
  const state = { hold: false, sockets: [] as WebSocketRoute[], sent: [] as string[] };
  await context.routeWebSocket(/realtime\/connect/, (socket) => {
    state.sockets.push(socket);
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      state.sent.push(String(message));
      server.send(message);
    });
    server.onMessage((message) => {
      if (!state.hold) socket.send(message);
    });
  });
  return state;
}

const scriptProblems: string[] = [];
function watch(page: Page) {
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) scriptProblems.push(message.text());
  });
  page.on('pageerror', (error) => scriptProblems.push(error.message));
}
test.beforeEach(() => {
  scriptProblems.length = 0;
});
test.afterEach(() => {
  expect(scriptProblems).toEqual([]);
});

test('loads the chat bundle only when idle or clicked, and a page view makes no session', async ({ browser }) => {
  const context = await visitorContext(browser);
  // Never idle, so that only the click can load it.
  await context.addInitScript(() => {
    window.requestIdleCallback = (() => 0) as typeof window.requestIdleCallback;
  });
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  const page = await shop(context);
  watch(page);
  await expect(launcher(page)).toBeVisible();
  expect(requests.some((url) => url.endsWith('/widget/chat.js'))).toBe(false);
  expect(requests.some((url) => url.includes('/api/'))).toBe(false);

  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(compose(page)).toBeFocused();
  expect(requests.some((url) => url.endsWith('/widget/chat.js'))).toBe(true);
  expect(requests.some((url) => url.includes('/widget/sessions'))).toBe(false);

  // When the browser does go idle, it loads with nobody clicking, and still no session.
  const idle = await shop(await visitorContext(browser));
  await idle.waitForResponse((r) => r.url().includes('/widget/bootstrap'));
  expect(await idle.evaluate(() => JSON.stringify(localStorage))).toBe('{}');
  await idle.context().close();
  await context.close();
});

test('a visitor and an agent talk in real time, with status, typing, and unread', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context);
  watch(page);
  const conversationId = await startChat(page, 'Do you ship to Hong Kong?');
  await expect(log(page).getByText('Sent', { exact: true })).toBeVisible();

  // Seen, only after an agent actually opens it.
  await inboxRow(agent, conversationId).click();
  await expect(agent.getByRole('list', { name: 'Messages' })).toContainText('Do you ship to Hong Kong?');
  await expect(log(page).getByText('Seen', { exact: true })).toBeVisible();

  // Typing, both ways.
  await agent.getByLabel('Reply').pressSequentially('Yes');
  await expect(panel(page).getByText('Typing…')).toBeVisible();
  await compose(page).pressSequentially('Great');
  await expect(agent.getByText(/typing/i)).toBeVisible();
  await compose(page).fill('');

  await reply(agent, 'Yes we do');
  await expect(log(page).getByText('Yes we do')).toBeVisible();
  await expect(panel(page).getByText('Typing…')).toBeHidden();

  // A note, sent ahead of a reply down the same path, whose arrival proves that the note was not still coming.
  await agent.getByRole('button', { name: 'Internal note' }).click();
  await agent.getByLabel('Internal note').fill('SECRET note');
  await agent.getByRole('button', { name: 'Add note' }).click();
  await expect(agent.getByRole('list', { name: 'Messages' })).toContainText('SECRET note');
  await agent.getByRole('button', { name: 'Reply', exact: true }).click();

  // Unread, on the button, while the panel is closed.
  await page.getByRole('button', { name: 'Close chat' }).first().click();
  await expect(launcher(page)).toBeFocused();
  await reply(agent, 'Delivery takes two days');
  await expect(launcher(page).locator('.oc-badge')).toHaveText('1');
  await expect(launcher(page)).toHaveAttribute('aria-label', 'Open chat, 1 unread');
  await launcher(page).click();
  await expect(log(page).getByText('Delivery takes two days')).toBeVisible();
  await expect(launcher(page).locator('.oc-badge')).toBeHidden();
  await expect(log(page)).not.toContainText('SECRET');

  // A new page: same visitor, the whole history once, and nothing unread.
  await page.reload();
  await launcher(page).click();
  await expect(log(page).getByText('Delivery takes two days')).toHaveCount(1);
  await expect(log(page).getByText('Do you ship to Hong Kong?')).toHaveCount(1);
  await expect(log(page)).not.toContainText('SECRET');
  await expect(launcher(page).locator('.oc-badge')).toBeHidden();
  await context.close();
  await agent.context().close();
});

test('shows content from anyone only as text, even under a hostile page style', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context);
  watch(page);
  const attack = '<img src=x onerror="window.__attacked=1"><script>window.__attacked=1</script>';
  const conversationId = await startChat(page, attack);
  await inboxRow(agent, conversationId).click();
  await reply(agent, attack.replace('<img', '<img id=agent'));
  await expect(log(page).getByText('id=agent')).toBeVisible();
  expect(await log(page).locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __attacked?: number }).__attacked)).toBeUndefined();
  // The page's stylesheet hides every button and sets 99px text. None of that reaches the shadow root.
  await expect(launcher(page)).toBeVisible();
  expect(await compose(page).evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
  await context.close();
  await agent.context().close();
});

test('a replayed send makes one message, and Try again keeps its identity', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context);
  watch(page);
  const conversationId = await startChat(page, 'First');

  // The server commits it, and the response is lost. The automatic retry is then a replay.
  const seen: string[] = [];
  let lose = true;
  await context.route(/\/conversations\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seen.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId);
    if (lose) {
      lose = false;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await say(page, 'Only once please');
  await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(2);
  expect(seen[0]).toBe(seen[1]);
  await expect(log(page).getByText('Sending…')).toBeHidden();
  await expect(log(page).getByText('Only once please')).toHaveCount(1);
  await inboxRow(agent, conversationId).click();
  await expect(agent.getByRole('list', { name: 'Messages' }).getByText('Only once please')).toHaveCount(1);
  await context.unroute(/\/conversations\/[^/]+\/messages$/);

  // Refused outright: it shows as failed straight away, and the visitor decides.
  const tried: string[] = [];
  let refuse = true;
  await context.route(/\/conversations\/[^/]+\/messages$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    tried.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId);
    return refuse ? route.fulfill({ status: 400, contentType: 'application/problem+json', body: '{}', headers: { 'access-control-allow-origin': SITE_ORIGIN } }) : route.continue();
  });
  await say(page, 'Second try');
  await expect(log(page).getByText('Not sent.')).toBeVisible();
  refuse = false;
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(log(page).getByText('Not sent.')).toBeHidden();
  await expect(agent.getByRole('list', { name: 'Messages' }).getByText('Second try')).toHaveCount(1);
  expect(tried).toHaveLength(2);
  expect(tried[0]).toBe(tried[1]);
  await context.close();
  await agent.context().close();
});

test('says plainly when a chat has reached its daily limit, and holds a visitor to the longest message', async ({ browser }) => {
  const context = await visitorContext(browser);
  const page = await shop(context);
  watch(page);
  await startChat(page, 'First');
  await expect(compose(page)).toHaveAttribute('maxlength', '4000');

  await context.route(/\/conversations\/[^/]+\/messages$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'retry-after': '3600' }, body: JSON.stringify({ type: 'about:blank', title: 'This chat cannot take more messages today', status: 429, code: 'daily_limit_reached' }) })
      : route.continue(),
  );
  await compose(page).fill('Second');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('This chat cannot take more messages today. Please try again later.');
  await context.close();
});

test('losing the socket mid-exchange loses nothing', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const socket = await controlSocket(context);
  const page = await shop(context);
  watch(page);
  const conversationId = await startChat(page, 'Are you there?');
  await inboxRow(agent, conversationId).click();
  await expect.poll(() => socket.sockets.length).toBeGreaterThan(0);

  socket.hold = true;
  await reply(agent, 'Sent while the socket was dead');
  await expect(log(page).getByText('Sent while the socket was dead')).toBeHidden();
  socket.hold = false;
  await socket.sockets[socket.sockets.length - 1]!.close({ code: 1011 });
  await expect(log(page).getByText('Sent while the socket was dead')).toHaveCount(1, { timeout: 15_000 });

  await reply(agent, 'And after it came back');
  await expect(log(page).getByText('And after it came back')).toHaveCount(1);
  await context.close();
  await agent.context().close();
});

test('works with sockets blocked, through REST', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  await context.routeWebSocket(/realtime\/connect/, (socket) => {
    void socket.close({ code: 1011 });
  });
  const page = await shop(context);
  watch(page);
  const conversationId = await startChat(page, 'My network blocks sockets');
  await inboxRow(agent, conversationId).click();
  await expect(panel(page).getByText('Reconnecting…')).toBeVisible();
  await reply(agent, 'Polling will find this');
  await expect(log(page).getByText('Polling will find this')).toBeVisible({ timeout: 50_000 });
  await say(page, 'And I can still write');
  await expect(agent.getByRole('list', { name: 'Messages' })).toContainText('And I can still write');
  await context.close();
  await agent.context().close();
});

test('runs under a strict content security policy, styled, with its own nonce', async ({ browser }) => {
  const context = await visitorContext(browser);
  const page = await shop(context, WEBSITE_KEY, { csp: true });
  watch(page);
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  expect(await panel(page).evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
  await say(page, 'Allowed by the policy');
  await expect(log(page).getByText('Sent', { exact: true })).toBeVisible();
  await context.close();
});

test('uses the website settings: colour with readable text, welcome, names, and a required email', async ({ browser }) => {
  const context = await visitorContext(browser);
  const page = await shop(context, STYLED_WEBSITE_KEY);
  watch(page);
  await expect
    .poll(() => launcher(page).evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color].join()))
    .toBe('rgb(253, 224, 71),rgb(17, 24, 39)');
  await launcher(page).click();
  await expect(log(page).getByText('Welcome to the shop')).toBeVisible();
  await expect(compose(page)).toBeHidden();
  await expect(panel(page).getByLabel('Name')).toBeFocused();

  const consentBox = panel(page).getByRole('checkbox', { name: /Email me about this conversation/ });
  await expect(consentBox).not.toBeChecked();
  await panel(page).getByLabel('Email', { exact: true }).fill('visitor@example.com');
  await consentBox.check();
  const saved = page.waitForRequest((request) => request.url().endsWith('/api/v1/widget/me') && request.method() === 'PATCH');
  await panel(page).getByRole('button', { name: 'Start chatting' }).click();
  expect((await saved).postDataJSON()).toMatchObject({ email: 'visitor@example.com', followUpConsent: true });
  await expect(compose(page)).toBeVisible();
  await page.reload();
  await launcher(page).click();
  await expect(compose(page)).toBeVisible();
  await context.close();
});

test('reads correctly on a page in another encoding, including what people write', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context, WEBSITE_KEY, { latin1: true });
  watch(page);
  const conversationId = await startChat(page, 'Caf\u00e9 \u4f60\u597d');
  await inboxRow(agent, conversationId).click();
  await expect(agent.getByRole('list', { name: 'Messages' })).toContainText('Caf\u00e9 \u4f60\u597d');
  await agent.getByLabel('Reply').pressSequentially('Yes');
  await expect(panel(page).getByText('Typing\u2026')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Close chat' }).first()).toHaveText('\u00d7');
  await context.close();
  await agent.context().close();
});

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

test('files go both ways, and a note\'s file never reaches the visitor', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context);
  watch(page);
  const thread = agent.getByRole('list', { name: 'Messages' });

  // Nothing to attach to before there is a conversation: a page view cannot be used to store files.
  await launcher(page).click();
  await expect(panel(page).getByRole('button', { name: 'Attach a file' })).toHaveCount(0);
  const conversationId = await (async () => {
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/widget/conversations') && r.request().method() === 'POST');
    await say(page, 'Here is the problem');
    return ((await (await created).json()) as { id: string }).id;
  })();
  await inboxRow(agent, conversationId).click();

  await panel(page).getByLabel('File to attach').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(thread.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect.poll(() => thread.getByRole('img', { name: 'screen.png' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  const saved = agent.waitForEvent('download');
  await thread.getByRole('button', { name: /Download screen\.png/ }).click();
  expect((await saved).suggestedFilename()).toBe('screen.png');
  await expect(log(page).getByRole('img', { name: 'screen.png' })).toBeVisible();

  // A file the server refuses shows why, and sends nothing.
  await panel(page).getByLabel('File to attach').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') });
  await expect(panel(page).getByRole('alert')).toContainText('cannot be sent');
  await expect(log(page).getByText('Not sent.')).toBeVisible();

  // From the agent, with words, and alone on a note.
  await agent.getByLabel('File to attach').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 test') });
  await expect(agent.getByRole('list', { name: 'Files to send' })).toContainText('invoice.pdf');
  await agent.getByLabel('Reply').fill('Your invoice');
  await agent.getByRole('button', { name: 'Send reply' }).click();
  await expect(log(page).getByText('Your invoice')).toBeVisible();
  const download = page.waitForEvent('download');
  await log(page).getByRole('button', { name: /Download invoice\.pdf/ }).click();
  expect((await download).suggestedFilename()).toBe('invoice.pdf');

  await agent.getByRole('button', { name: 'Internal note' }).click();
  await agent.getByLabel('File to attach').setInputFiles({ name: 'SECRET.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(agent.getByRole('list', { name: 'Files to send' })).toContainText('SECRET.png');
  await agent.getByRole('button', { name: 'Add note' }).click();
  await expect(thread.getByRole('img', { name: 'SECRET.png' })).toBeVisible();
  await agent.getByRole('button', { name: 'Reply', exact: true }).click();
  await reply(agent, 'After the note');
  await expect(log(page).getByText('After the note')).toBeVisible();
  await expect(log(page)).not.toContainText('SECRET');

  await page.reload();
  await launcher(page).click();
  await expect(log(page).getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect(log(page)).not.toContainText('SECRET');
  await context.close();
  await agent.context().close();
});

test('a page that refuses blob pictures still gets the download', async ({ browser }) => {
  const agent = await openInbox(browser);
  const context = await visitorContext(browser);
  const page = await shop(context, WEBSITE_KEY, { csp: true });
  // The refused picture is the point of this test, so its report is expected.
  const conversationId = await startChat(page, 'A strict page');
  await inboxRow(agent, conversationId).click();
  await agent.getByLabel('File to attach').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(agent.getByRole('list', { name: 'Files to send' })).toContainText('photo.png');
  await agent.getByRole('button', { name: 'Send reply' }).click();
  await expect(log(page).getByRole('button', { name: /Download photo\.png/ })).toBeVisible();
  await expect(log(page).getByRole('img', { name: 'photo.png' })).toHaveCount(0);
  const saved = page.waitForEvent('download');
  await log(page).getByRole('button', { name: /Download photo\.png/ }).click();
  expect((await saved).suggestedFilename()).toBe('photo.png');
  await context.close();
  await agent.context().close();
});

/** Stands in for Cloudflare's script only. The token it gives is the published test token, and the Worker really asks Cloudflare about it. */
const fakeTurnstile = (context: BrowserContext, behaviour: 'pass' | 'fail') =>
  context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.__challenges = 0; window.turnstile = { render(element, options) { window.__challenges++; setTimeout(() => ${behaviour === 'pass' ? "options.callback('XXXX.DUMMY.TOKEN.XXXX')" : "options['error-callback']()"}); return 'id'; }, remove() {} };`,
    }),
  );

test('a website that requires Turnstile checks a new visitor once, when they first write', async ({ browser }) => {
  const context = await visitorContext(browser);
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  await fakeTurnstile(context, 'pass');
  const page = await shop(context, TURNSTILE_WEBSITE_KEY);
  watch(page);
  await launcher(page).click();
  await expect(compose(page)).toBeVisible();
  // Just looking contacts nobody.
  expect(requests.some((url) => url.includes('challenges.cloudflare.com'))).toBe(false);

  await say(page, 'Am I a person?');
  await expect(log(page).getByText('Sent', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __challenges: number }).__challenges)).toBe(1);

  // Known now, so no second check, even on a new page.
  await page.reload();
  await launcher(page).click();
  await expect(log(page).getByText('Am I a person?')).toBeVisible();
  await say(page, 'Still me');
  await expect(log(page).getByText('Still me')).toBeVisible();
  await expect(log(page).getByText('Not sent.')).toHaveCount(0);
  expect(requests.filter((url) => url.includes('challenges.cloudflare.com'))).toHaveLength(1);
  await context.close();
});

test('a failed Turnstile check says so, sends nothing, and can be tried again', async ({ browser }) => {
  const context = await visitorContext(browser);
  await fakeTurnstile(context, 'fail');
  const page = await shop(context, TURNSTILE_WEBSITE_KEY);
  watch(page);
  await launcher(page).click();
  await say(page, 'Let me in');
  await expect(log(page).getByText('Not sent.')).toBeVisible();
  await expect(panel(page).getByRole('alert')).toContainText('could not confirm');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('refreshToken');

  await context.unroute('https://challenges.cloudflare.com/**');
  await page.evaluate(() => {
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });
  await fakeTurnstile(context, 'pass');
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(log(page).getByText('Sent', { exact: true })).toBeVisible();
  await context.close();
});

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><svg onload="window.__pwned=1">`;

test('text from a stranger stays text, on the visitor\'s page and in the inbox', async ({ browser }) => {
  const context = await visitorContext(browser);
  const page = await shop(context, WEBSITE_KEY);
  watch(page);
  await launcher(page).click();
  await say(page, `${XSS} visitor words`);
  await expect(log(page).getByText('Sent', { exact: true })).toBeVisible();
  // A name and a file name are also the visitor's to choose.
  const authorization = page.waitForRequest((request) => request.url().includes('/attachments') && request.method() === 'POST');
  const fileName = '<img src=x onerror=window.__pwned=1>.txt';
  await panel(page).getByLabel('File to attach').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('words') });
  const headers = (await authorization).headers();
  await expect(log(page).getByText(fileName, { exact: false })).toBeVisible();
  const profile = await context.request.patch(`${BASE_URL}/api/v1/widget/me`, { headers: { authorization: headers.authorization!, origin: SITE_ORIGIN }, data: { name: '<img src=x onerror=window.__pwned=1>' } });
  expect(profile.status()).toBe(204);

  const agentContext = await browser.newContext();
  const agent = await agentContext.newPage();
  await signIn(agent, OWNER);
  await agent.getByRole('region', { name: 'Conversations' }).getByRole('button').first().click();
  await expect(agent.getByText('visitor words', { exact: false }).first()).toBeVisible();
  await expect(agent.getByText(fileName, { exact: false }).first()).toBeVisible();

  // An agent's words can carry it the other way, if an account is ever stolen.
  await agent.getByLabel('Reply').fill(`${XSS} agent words`);
  await agent.getByRole('button', { name: 'Send reply' }).click();
  await expect(log(page).getByText('agent words', { exact: false })).toBeVisible();

  // Nothing ran, and nothing became an element.
  for (const target of [page, agent]) expect(await target.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('#openchat-widget img[src="x"], #openchat-widget svg[onload]').count()).toBe(0);
  expect(await agent.locator('img[src="x"], svg[onload]').count()).toBe(0);
  await agentContext.close();
  await context.close();
});

test('removes itself from a page the website does not allow', async ({ browser }) => {
  const context = await visitorContext(browser);
  const refused = context.waitForEvent('response', (r) => r.url().includes('/widget/bootstrap'));
  const page = await shop(context, WEBSITE_KEY, { origin: 'https://elsewhere.example' });
  // It was there first, so that the assertion below is not just the script not having run yet.
  expect((await refused).status()).toBe(403);
  await expect(page.locator('#openchat-widget')).toHaveCount(0);
  await context.close();
});

test('holds identity in the session until the page grants consent', async ({ browser }) => {
  const context = await visitorContext(browser);
  const page = await shop(context, WEBSITE_KEY, { consent: true });
  watch(page);
  await startChat(page, 'No consent yet');
  const area = (name: 'localStorage' | 'sessionStorage') => page.evaluate((n) => JSON.stringify(window[n]), name);
  expect(await area('localStorage')).toBe('{}');
  expect(await area('sessionStorage')).toContain('openchat:');
  await page.evaluate(() => window.OpenChat!.grantConsent());
  expect(await area('localStorage')).toContain('refreshToken');
  expect(await area('sessionStorage')).not.toContain('openchat:');
  await context.close();
});

test('fills a phone screen, and closes back to the button', async ({ browser }) => {
  const context = await visitorContext(browser, { width: 375, height: 667 });
  const page = await shop(context);
  watch(page);
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  // Polled, because the panel slides in.
  await expect
    .poll(async () => {
      const box = (await panel(page).boundingBox())!;
      return [box.x, box.y, box.width, box.height].map(Math.round);
    })
    .toEqual([0, 0, 375, 667]);
  const close = panel(page).getByRole('button', { name: 'Close chat' });
  const box = (await close.boundingBox())!;
  expect(Math.round(Math.min(box.width, box.height))).toBeGreaterThanOrEqual(44);
  await compose(page).press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await context.close();
});

declare global {
  interface Window {
    OpenChat?: { open(): void; close(): void; grantConsent(): void };
  }
}

test.describe('languages', () => {
  test('the widget speaks the page’s language', async ({ browser }) => {
    const context = await visitorContext(browser);
    const page = await shop(context, WEBSITE_KEY, { lang: 'fr-CA' });
    await expect(launcher(page)).toHaveAttribute('aria-label', 'Ouvrir le chat');
    await launcher(page).click();
    const dialog = page.getByRole('dialog', { name: 'Chat' });
    await expect(dialog).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible();
    await expect(launcher(page)).toHaveAttribute('aria-label', 'Fermer le chat');
    await context.close();
  });

  test('a page can ask for a language, ahead of its own and the browser’s', async ({ browser }) => {
    const context = await visitorContext(browser, undefined, 'de-DE');
    const page = await shop(context, WEBSITE_KEY, { lang: 'en', locale: 'ja' });
    await expect(launcher(page)).toHaveAttribute('aria-label', 'チャットを開く');
    await launcher(page).click();
    await expect(page.getByRole('dialog', { name: 'チャット' })).toHaveAttribute('lang', 'ja');
    await context.close();
  });

  test('with no language on the page, the browser’s decides, in traditional script for Hong Kong', async ({ browser }) => {
    const context = await visitorContext(browser, undefined, 'zh-HK');
    const page = await shop(context, WEBSITE_KEY, { lang: '' });
    await launcher(page).click();
    await expect(page.getByRole('dialog', { name: '聊天' })).toHaveAttribute('lang', 'zh-Hant');
    await expect(page.getByRole('button', { name: '傳送', exact: true })).toBeVisible();
    await context.close();
  });
});
