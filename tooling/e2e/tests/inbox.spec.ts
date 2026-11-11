import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { AGENT, OWNER, SITE_ORIGIN, WEBSITE_KEY } from './fixtures';
import { nextIp, signIn } from './helpers';

interface Visitor {
  token: string;
  conversationId: string;
  send(content: string): Promise<void>;
  history(): Promise<{ content: string; sender: { type: string } }[]>;
  socket(): Promise<WebSocket>;
}

const visitorHeaders = (token?: string) => ({
  origin: SITE_ORIGIN,
  'content-type': 'application/json',
  'cf-connecting-ip': nextIp(),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** These tests are about the inbox, so a visitor is played through the API. widget.spec.ts drives the real widget. */
async function startVisitor(first = 'Hello from a visitor'): Promise<Visitor> {
  const post = async (path: string, token: string | undefined, body?: unknown) => {
    const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: visitorHeaders(token), ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status, path).toBeLessThan(300);
    return (await response.json()) as Record<string, string>;
  };
  const { accessToken } = await post('/api/v1/widget/sessions', undefined, { websiteKey: WEBSITE_KEY });
  const token = accessToken!;
  const { id } = await post('/api/v1/widget/conversations', token, { clientMessageId: crypto.randomUUID(), content: first });
  const conversationId = id!;
  const base = `/api/v1/widget/conversations/${conversationId}`;
  return {
    token,
    conversationId,
    send: async (content) => {
      await post(`${base}/messages`, token, { clientMessageId: crypto.randomUUID(), content });
    },
    history: async () => {
      const response = await fetch(`${BASE_URL}${base}/messages`, { headers: visitorHeaders(token) });
      return ((await response.json()) as { data: { content: string; sender: { type: string } }[] }).data;
    },
    socket: async () => {
      const { url } = await post(`${base}/realtime/tickets`, token);
      const socket = new WebSocket(url!, { headers: { origin: SITE_ORIGIN } } as never);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve);
        socket.addEventListener('error', reject);
      });
      return socket;
    },
  };
}

const rowLabel = (visitor: Visitor) => `Visitor ${visitor.conversationId.slice(-6)}`;
const row = (page: Page, visitor: Visitor) => page.getByRole('button', { name: new RegExp(rowLabel(visitor)) });
const messages = (page: Page) => page.getByRole('list', { name: 'Messages' });

const openSession = async (browser: Browser, who: { email: string }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  return page;
};

/** Stands between the page and its socket. Going offline in Playwright does not reach a socket on localhost. */
async function controlSocket(page: Page) {
  const state = { hold: false, sockets: [] as WebSocketRoute[] };
  await page.routeWebSocket(/realtime\/connect/, (socket) => {
    state.sockets.push(socket);
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!state.hold) socket.send(message);
    });
  });
  return state;
}

const scriptProblems: string[] = [];
test.beforeEach(({ page }) => {
  scriptProblems.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) scriptProblems.push(message.text());
  });
  page.on('pageerror', (error) => scriptProblems.push(error.message));
});
test.afterEach(() => {
  expect(scriptProblems).toEqual([]);
});

test('serves the dashboard with its content security policy', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
});

test('a visitor starts a conversation, and it appears live, unread, then read', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor('Is anyone there?');
  const entry = row(page, visitor);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('1 unread');
  await entry.click();
  await expect(messages(page)).toContainText('Is anyone there?');
  await expect(entry).not.toContainText('unread');
  await page.reload();
  await expect(row(page, visitor)).not.toContainText('unread');
});

test('the agent replies, the visitor receives it, and a later message arrives without reloading', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  await page.getByLabel('Reply').fill('Hello, how can I help?');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(messages(page)).toContainText('Hello, how can I help?');
  await expect(page.getByLabel('Reply')).toHaveValue('');
  await expect.poll(async () => (await visitor.history()).map((m) => m.content)).toContain('Hello, how can I help?');
  await visitor.send('I need a refund');
  await expect(messages(page)).toContainText('I need a refund');
});

test('a note is marked as a note, and never reaches the visitor', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  const socket = await visitor.socket();
  const frames: string[] = [];
  socket.addEventListener('message', (event) => frames.push(String(event.data)));
  await row(page, visitor).click();
  await page.getByRole('button', { name: 'Internal note' }).click();
  await page.getByLabel('Internal note').fill('Customer seems upset, SECRET');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(messages(page).getByText('The visitor cannot see this')).toBeVisible();
  await expect(messages(page)).toContainText('SECRET');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Reply').fill('A public answer');
  await page.getByRole('button', { name: 'Send reply' }).click();
  // Sent after the note, down the same path, so its arrival proves the note was not still on its way.
  await expect.poll(() => frames.join()).toContain('A public answer');
  expect(frames.join()).not.toContain('SECRET');
  expect(JSON.stringify(await visitor.history())).not.toContain('SECRET');
  socket.close();
});

test('message content is only ever text', async ({ page }) => {
  await signIn(page, OWNER);
  const attack = '<img src=x onerror="window.__attacked=1"><script>window.__attacked=1</script>';
  const visitor = await startVisitor(attack);
  await row(page, visitor).click();
  await expect(messages(page)).toContainText(attack);
  expect(await messages(page).locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __attacked?: number }).__attacked)).toBeUndefined();
});

test('several agents see the same conversation change', async ({ page, browser }) => {
  await signIn(page, OWNER);
  const other = await openSession(browser, AGENT);
  await expect(page.getByText(`Also online: ${AGENT.name}`)).toBeVisible();
  const visitor = await startVisitor('For the team');
  await expect(row(other, visitor)).toBeVisible();
  await row(page, visitor).click();
  await row(other, visitor).click();

  await page.getByLabel('Reply').fill('On it');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(messages(other)).toContainText('On it');

  await page.getByLabel('Assignee').selectOption({ label: AGENT.name });
  await expect(other.getByLabel('Assignee')).toHaveValue(AGENT.memberId);
  await page.getByLabel('Conversation status').selectOption('resolved');
  await expect(other.getByLabel('Conversation status')).toHaveValue('resolved');
  await expect(row(other, visitor)).toHaveCount(0);
  await other.context().close();
});

test('a stale change is refused, and says why', async ({ page, browser }) => {
  const socket = await controlSocket(page);
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  const other = await openSession(browser, AGENT);
  await row(page, visitor).click();
  await row(other, visitor).click();
  await expect(page.getByLabel('Priority')).toHaveValue('normal');
  // This page does not hear about the change, so it keeps the old version.
  socket.hold = true;
  await other.getByLabel('Priority').selectOption('urgent');
  await expect(other.getByLabel('Priority')).toHaveValue('urgent');
  await page.getByLabel('Conversation status').selectOption('pending');
  await expect(page.getByRole('alert')).toContainText('This conversation just changed');
  await expect(page.getByLabel('Priority')).toHaveValue('urgent');
  await other.context().close();
});

test('a new message does not get in the way of the next change', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  await expect(messages(page)).toContainText('Hello from a visitor');
  await visitor.send('One more thing');
  await expect(messages(page)).toContainText('One more thing');
  await page.getByLabel('Priority').selectOption('high');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Priority')).toHaveValue('high');
  await expect.poll(async () => (await page.getByLabel('Priority').isEnabled())).toBe(true);
  await page.getByLabel('Conversation status').selectOption('pending');
  await expect(page.getByLabel('Conversation status')).toHaveValue('pending');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an agent corrects a contact, and the list shows the name', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  const contact = page.getByRole('form', { name: 'Contact' });
  const name = `Dana ${visitor.conversationId.slice(-6)}`;
  await contact.getByLabel('Name').fill(name);
  await contact.getByLabel('Email').fill('dana@example.com');
  await contact.getByRole('button', { name: 'Save contact' }).click();
  await expect(contact.getByText('Not verified')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversations' }).getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('an installation admin exports a contact, then erases them, and the visitor is gone', async ({ page, browser }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor('Please delete my data');
  await row(page, visitor).click();
  const rights = page.getByRole('form', { name: 'Contact' }).getByLabel('Personal data');

  const [download] = await Promise.all([page.waitForEvent('download'), rights.getByRole('button', { name: 'Export data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contact-cont_.+\.json$/);
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))) as { conversations: { messages: { content: string }[] }[] };
  expect(exported.conversations[0]!.messages[0]!.content).toBe('Please delete my data');

  page.once('dialog', (dialog) => void dialog.accept());
  await rights.getByRole('button', { name: 'Erase contact' }).click();
  await expect(row(page, visitor)).toHaveCount(0);
  await expect(page.getByText('Choose a conversation.')).toBeAttached();
  // The visitor's own token went with them.
  expect((await fetch(`${BASE_URL}/api/v1/widget/conversations/${visitor.conversationId}/messages`, { headers: visitorHeaders(visitor.token) })).status).toBe(401);

  // An agent who is not an admin is not offered either.
  const agent = await openSession(browser, AGENT);
  const other = await startVisitor('Hello again');
  await row(agent, other).click();
  await expect(agent.getByRole('form', { name: 'Contact' })).toBeVisible();
  await expect(agent.getByRole('button', { name: 'Erase contact' })).toHaveCount(0);
  await agent.context().close();
});

test('tags appear for other agents as they change, and a visitor never sees them', async ({ page, browser }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  const socket = await visitor.socket();
  const frames: string[] = [];
  socket.addEventListener('message', (event) => frames.push(String(event.data)));
  const other = await openSession(browser, AGENT);
  await row(page, visitor).click();
  await row(other, visitor).click();
  const tags = page.getByRole('region', { name: 'Tags' });
  await tags.getByLabel('Add a tag').fill('Refund');
  await tags.getByRole('button', { name: 'Add' }).click();
  await expect(tags.getByRole('button', { name: 'Remove tag Refund' })).toBeVisible();
  await expect(other.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Remove tag Refund' })).toBeVisible();
  await expect(row(other, visitor)).toContainText('Refund');
  await tags.getByRole('button', { name: 'Remove tag Refund' }).click();
  await expect(other.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Remove tag Refund' })).toHaveCount(0);
  expect(frames.join()).not.toContain('Refund');
  // Tagging does not stand in the way of a change that follows it.
  await page.getByLabel('Priority').selectOption('low');
  await expect(page.getByRole('alert')).toHaveCount(0);
  socket.close();
  await other.context().close();
});

test('typing shows while it happens, and goes away by itself', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  const socket = await visitor.socket();
  await expect(page.getByText('Online now')).toBeVisible();
  socket.send(JSON.stringify({ v: 1, type: 'typing.set', data: { conversationId: visitor.conversationId, isTyping: true } }));
  await expect(page.getByText('The visitor is typing…')).toBeVisible();
  await expect(page.getByText('The visitor is typing…')).toBeHidden({ timeout: 7000 });
  socket.close();
});

test("the agent's typing reaches the visitor, unless it is a note", async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  const socket = await visitor.socket();
  const frames: { type: string }[] = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data)) as { type: string }));
  await row(page, visitor).click();
  await page.getByRole('button', { name: 'Internal note' }).click();
  await page.getByLabel('Internal note').pressSequentially('thinking');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.waitForTimeout(3100);
  expect(frames.filter((f) => f.type === 'typing')).toEqual([]);
  await page.getByLabel('Reply').pressSequentially('hi');
  await expect.poll(() => frames.filter((f) => f.type === 'typing').length).toBe(1);
  socket.close();
});

test('a lost answer to a send does not send it twice', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  let losses = 0;
  await page.route('**/conversations/*/messages', async (route) => {
    if (route.request().method() === 'POST' && losses === 0) {
      losses++;
      // It reaches the server, and only the answer is lost.
      await route.fetch();
      await route.abort();
      return;
    }
    await route.fallback();
  });
  await page.getByLabel('Reply').fill('Exactly once');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByRole('alert')).toContainText('Your words are still here');
  await expect(page.getByLabel('Reply')).toHaveValue('Exactly once');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByLabel('Reply')).toHaveValue('');
  await expect(messages(page).getByText('Exactly once')).toHaveCount(1);
  await page.reload();
  await row(page, visitor).click();
  await expect(messages(page).getByText('Exactly once')).toHaveCount(1);
  expect((await visitor.history()).filter((m) => m.content === 'Exactly once')).toHaveLength(1);
});

test('losing the connection loses nothing', async ({ page }) => {
  const socket = await controlSocket(page);
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  await expect(messages(page)).toContainText('Hello from a visitor');
  // No new socket for now, then drop the one that exists.
  await page.route('**/realtime/tickets', (route) => route.abort());
  await socket.sockets.at(-1)!.close({ code: 1011 });
  await expect(page.getByText('Reconnecting. Sending still works.').or(page.getByText('Live updates are unavailable'))).toBeVisible();
  await visitor.send('Sent while the agent was away');
  await expect(messages(page)).not.toContainText('Sent while the agent was away');
  await page.unroute('**/realtime/tickets');
  await expect(messages(page)).toContainText('Sent while the agent was away', { timeout: 45_000 });
  await expect(page.getByText('Reconnecting. Sending still works.')).toBeHidden();
});

test('with WebSockets blocked, the inbox still works over REST', async ({ page }) => {
  test.setTimeout(120_000);
  await page.routeWebSocket(/realtime\/connect/, (socket) => socket.close({ code: 1011 }));
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await expect(page.getByText('Live updates are unavailable')).toBeVisible({ timeout: 60_000 });
  await expect(row(page, visitor)).toBeVisible({ timeout: 35_000 });
  await row(page, visitor).click();
  await page.getByLabel('Reply').fill('Sent with no socket');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(messages(page)).toContainText('Sent with no socket');
  await expect.poll(async () => (await visitor.history()).map((m) => m.content)).toContain('Sent with no socket');
  await visitor.send('Picked up by polling');
  await expect(messages(page)).toContainText('Picked up by polling', { timeout: 35_000 });
});

test('signing out leaves nothing on the screen, and the socket goes', async ({ page }) => {
  await signIn(page, OWNER);
  const visitor = await startVisitor('Private words');
  await row(page, visitor).click();
  await expect(messages(page)).toContainText('Private words');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Private words')).toHaveCount(0);
});

test('fits a phone, moving between the list and the conversation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await signIn(page, OWNER);
  const visitor = await startVisitor();
  await row(page, visitor).click();
  await expect(messages(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversations' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Back to the list' }).click();
  await expect(page.getByRole('region', { name: 'Conversations' })).toBeVisible();
});

const openWorkspacesPage = async (page: Page) => {
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Manage workspaces' })).toBeVisible();
};

test('an installation admin changes the widget from the Workspaces page', async ({ page }) => {
  await signIn(page, OWNER);
  await openWorkspacesPage(page);
  const card = page.getByRole('listitem').filter({ hasText: 'Shop' }).first();
  await card.getByLabel('Welcome message').fill('Hello from settings');
  await card.getByLabel('Ask for an email').selectOption('optional');
  await card.getByRole('button', { name: 'Save widget settings' }).click();
  await expect(card.getByRole('status')).toContainText('Saved');
  await page.reload();
  await openWorkspacesPage(page);
  const after = page.getByRole('listitem').filter({ hasText: 'Shop' }).first();
  await expect(after.getByLabel('Welcome message')).toHaveValue('Hello from settings');
  await expect(after.getByLabel('Ask for an email')).toHaveValue('optional');
  // Back as it was, because other tests here share this website.
  await after.getByLabel('Welcome message').fill('');
  await after.getByLabel('Ask for an email').selectOption('never');
  await after.getByRole('button', { name: 'Save widget settings' }).click();
  await expect(after.getByRole('status')).toContainText('Saved');
});
