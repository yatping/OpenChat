# Self-hosting guide

This guide takes you from nothing to your own OpenChat. The backend, your conversations, and your data are on your own Cloudflare account. Your team uses the dashboard in a browser, and the official OpenChat iPhone app.

| | |
|---|---|
| You run | The backend, on your Cloudflare account |
| Your team uses | The dashboard in a browser, and the official OpenChat app |
| Push notifications go through | The OpenChat project's relay. It holds your team's device tokens and sees when a notification is sent. Your backend encrypts each notification for each phone, so the relay carries the message text and workspace name without being able to read them ([ADR-0017](../architecture/decisions/0017-encrypted-notifications.md)). Message text appears in notifications for everyone; each person can hide it on the lock screen with iOS's **Show Previews** setting. Tell your team |
| You need | A Cloudflare account |
| Time | About 30 minutes |

The iPhone app and the relay are not open source ([ADR-0019](../architecture/decisions/0019-app-and-relay-leave-open-source.md)), so this repository no longer builds your own branded app or runs your own relay. Everything else is here.

Follow the steps in order. Each one says what you should see. If you see something else, stop and look in [When something goes wrong](#when-something-goes-wrong).

The background for each step is in [deployment](deployment.md).

## What you need

| | For | Notes |
|---|---|---|
| A Mac | Everything | macOS, with a terminal. Linux may work, but has not been tried |
| Git | Getting the code | On a Mac, it comes with Xcode's command line tools |
| Node 24 | The CLI | From [nodejs.org](https://nodejs.org), or `nvm install 24` |
| A Cloudflare account | The backend | On the **Workers Paid** plan. The free plan cannot run password hashing |
| An iPhone | The official app | Optional |
| A website you can edit | The chat widget | Optional. Any page where you can add one line of HTML |

## 1. Get the code

```bash
git clone https://github.com/yatping/OpenChat.git openchat
cd openchat
git checkout $(git describe --tags --abbrev=0)
corepack enable
pnpm install --frozen-lockfile
```

The `checkout` line picks the latest release. `corepack` comes with Node 24, and installs the version of pnpm this project pins. If your shell says `corepack: command not found`, run `npm install -g corepack` first.

You should see `pnpm install` finish with `Done`. Run every later command from this `openchat` directory unless a step says otherwise.

## 2. Prepare Cloudflare

In the [Cloudflare dashboard](https://dash.cloudflare.com):

1. **Workers & Pages > Plans:** choose Workers Paid.
2. **Storage & databases > R2 > Overview:** complete the one-time sign-up for R2. It needs no bucket.
3. **Workers & Pages:** if asked to choose a `workers.dev` subdomain, choose one. Your addresses will look like `https://oc-production.<subdomain>.workers.dev`.

Then sign in from the terminal, and check:

```bash
pnpm --filter @openchat/api exec wrangler login
pnpm oc preflight
```

`wrangler login` opens a browser for you to allow access. `oc preflight` only reads, and creates nothing. You should see every line marked `ok`, `confirm`, or `note`, and none marked `FAIL`. The `confirm` lines are what Wrangler cannot see: check the plan and the subdomain yourself. If your login reaches several Cloudflare accounts, it says so: set `CLOUDFLARE_ACCOUNT_ID` to the one you want, and run it again.

## 3. Deploy the backend

Choose a short name for this environment, such as `production`. It is used in every resource name, so use lowercase letters, numbers, and hyphens. This guide uses `production`.

```bash
pnpm oc deploy --env production --owner-email you@company.com --workspace "Support"
```

It takes a few minutes. At the end you should see:

```text
Deployed 0.x.y: https://oc-production.<subdomain>.workers.dev

Set the owner's password within one hour. This link is shown only once:
https://oc-production.<subdomain>.workers.dev/reset-password#token=...
```

Open the link and set a password. The link works once, for one hour. If you miss it, run `pnpm oc recover --env production --email you@company.com` for a new one.

**Keep the `.openchat/` directory.** It records what was created, and later commands need it. It holds no passwords, but treat it as private, and back it up.

## 4. Sign in to the dashboard

Open `https://oc-production.<subdomain>.workers.dev` and sign in with your email and the password you just set. You should see the inbox of the `Support` workspace, which is empty.

You are the installation admin. **People** adds your team, and **Workspaces** holds workspaces and their websites.

### Optional: email

Without email, new team members and password resets need `oc recover`. To send email, your domain must use Cloudflare DNS on this account. Then:

```bash
pnpm --filter @openchat/api exec wrangler email sending enable mail.company.com
pnpm oc deploy --env production --cloudflare-email --email-from no-reply@mail.company.com
```

Enabling a domain sets its DMARC policy to `reject`, so use a subdomain if anything else sends mail from the main one.

### Optional: a security contact

So that someone who finds a problem with your installation knows where to report it, publish `/.well-known/security.txt`:

```bash
pnpm oc deploy --env production --security-contact mailto:security@company.com
```

Problems in OpenChat's own code go to the project, as [SECURITY.md](../../SECURITY.md) describes, and the file says so.

### If you changed the code

OpenChat's server is under the AGPL, which asks that the people using a changed version be offered its source. Your dashboard's footer links to the source of the release you deployed. If you deploy changes, publish them, then point the link there:

```bash
pnpm oc deploy --env production --source-url https://git.company.com/openchat
```

`oc deploy` reminds you when the checkout differs from the release. See [licensing](licensing.md#the-source-offer).

## 5. Put the chat widget on your website

1. In the dashboard, open **Workspaces**. Under **Workspace to manage**, choose yours.
2. Under **Add a website**, name it, and under **Allowed origins** enter your site's address, such as `https://www.company.com`, with no path. Then **Add website**. The widget refuses to load anywhere else.
3. Copy the snippet shown in the website's card. It looks like `<script src="https://oc-production.../widget/widget.js" data-website-key="..." async></script>`.
4. Paste it into your site's HTML, just before `</body>`, and publish.

Open your site. You should see a chat button in the bottom corner. Send a message from it. You should see it arrive in the dashboard inbox within a second, and a reply from the dashboard appear in the widget.

You now have working customer chat. Go on to step 6 for the iPhone app.

## 6. Push through the official app

The official app, and the project's relay that sends its notifications, need nothing from you but your installation ID. Two things to know first:

- **The official app is not on the App Store yet.** Until it is, your team uses the dashboard in a browser, and gets no push notifications.
- **The project's relay is open to every installation.** You do not ask for access: your backend registers itself the first time a phone turns on notifications, by proving it controls its address. There are [limits](../notification-relay/protocol.md#rate-limits) on how many installations can register, per network address and per day. If registration is paused, it is tried again later.

Point your backend at the project's relay:

```bash
pnpm oc deploy --env production \
  --relay-url https://openchat-relay.orangolabs.com \
  --relay-id managed --relay-bundle-ids com.orangolabs.openchat
```

You should see `Deployed` again. Then, in the official app on each iPhone: enter your backend's address, `oc-production.<subdomain>.workers.dev`, sign in, and allow notifications. In the app's **Settings**, you should see **Notifications** with switches. Lock the phone and send a message from your widget: a notification should arrive within a few seconds.

To stop using the project's relay later, in the dashboard choose **Workspaces**, then **Disconnect and erase** under **Push notifications**. Push stops, and the relay erases what it holds about your installation. Then run `pnpm oc deploy --env production --no-relay` to take it out of your deployment.

Keep it up to date with [step 7](#7-keep-it-up-to-date).

## 7. Keep it up to date

When a new release comes out, read its notes, then:

```bash
git fetch --tags
git checkout <new tag>
pnpm install --frozen-lockfile
pnpm oc upgrade --env production
```

`oc upgrade` records how to undo itself before changing anything, and puts the old version back by itself if the new one is unhealthy. If you find a problem later, `pnpm oc rollback --env production` puts the previous version back. See [upgrades](deployment.md#upgrades-oc-upgrade).

To check on it at any time, `pnpm oc health --env production` reads the [health checks](monitoring.md), which also says what to alert on.

D1 keeps 30 days of history by itself. For longer, run `pnpm oc backup --env production` on a schedule, and keep the files encrypted, away from Cloudflare. See [backup and restore](backup-and-restore.md).

The official app updates through the App Store.

## When something goes wrong

| You see | Do |
|---|---|
| `oc preflight` marks something `FAIL` | Its line says what to do. Nothing was created, so fix it and run it again |
| A deploy stops part way | Run the same command again. It resumes, and creates nothing twice |
| `already exists, and this deployment did not create it` | Something on the account already has that name. Choose another `--env` name |
| `The deployment did not become healthy`, and login is erroring | The account is not on Workers Paid |
| The app's Settings say this installation uses a notification service it cannot use | The backend must use the project's relay, exactly as in [step 6](#6-push-through-the-official-app). Check `relay` in `curl .../.well-known/openchat.json` |
| The widget does not appear on your site | The page's address must match an allowed origin exactly, including `https://` and `www`. If the site has a content security policy, it must allow your backend's address for scripts and connections |

## Removing everything

There is no single command yet. In the Cloudflare dashboard, or with `pnpm --filter @openchat/api exec wrangler`, delete in this order, because Cloudflare refuses otherwise: each queue's consumer, the Worker `oc-production`, the queues, the R2 bucket `oc-production-attachments`, and the D1 database `oc-production`. Deleting a Worker can go on failing for a few minutes after its consumers are removed, with error 10064. Wait and try again. Then delete `.openchat/production`.
