# Self-hosting guide

This guide takes you from nothing to your own OpenChat: the backend on your Cloudflare account, your own notification relay, and your own iOS app with push, signed under your own Apple account. Nothing in it uses credentials held by the OpenChat project.

Follow the steps in order. Each one says what you should see. If you see something else, stop and look in [When something goes wrong](#when-something-goes-wrong).

Allow about two hours the first time, most of it in Apple's portals. You can stop after [step 5](#5-put-the-chat-widget-on-your-website) and have a working chat widget and team inbox, with no Apple account at all.

The background for each step is in [deployment](deployment.md) and [the iOS build guide](../ios-build/expo-and-white-label.md).

## What you need

| | For | Notes |
|---|---|---|
| A Mac | Everything | macOS, with a terminal |
| [Xcode](https://apps.apple.com/app/xcode/id497799835) | The app | Open it once after installing, and accept the licence |
| [Homebrew](https://brew.sh) | Installing the tools below | |
| Git | Getting the code | Comes with Xcode |
| Node 24 | The CLI | From [nodejs.org](https://nodejs.org), or `nvm install 24` |
| CocoaPods and fastlane | The app | `brew install cocoapods fastlane` |
| A Cloudflare account | The backend | On the **Workers Paid** plan. The free plan cannot run password hashing |
| An Apple Developer Program membership | The app and push | [Enrol](https://developer.apple.com/programs/enroll/). It can take a day or more to be approved |
| An iPhone | Trying the app | With a cable |
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

## 5. Put the chat widget on your website

1. In the dashboard, open **Workspaces**. Under **Workspace to manage**, choose yours.
2. Under **Add a website**, name it, and under **Allowed origins** enter your site's address, such as `https://www.company.com`, with no path. Then **Add website**. The widget refuses to load anywhere else.
3. Copy the snippet shown in the website's card. It looks like `<script src="https://oc-production.../widget/widget.js" data-website-key="..." async></script>`.
4. Paste it into your site's HTML, just before `</body>`, and publish.

Open your site. You should see a chat button in the bottom corner. Send a message from it. You should see it arrive in the dashboard inbox within a second, and a reply from the dashboard appear in the widget.

You now have working customer chat. The rest of this guide adds your own iPhone app with push notifications.

## 6. Prepare Apple

Do this in your browser, signed in to your Apple Developer account. You will collect six things. Write each down as you go.

| # | You get | Used for |
|---|---|---|
| 1 | Team ID | Everything |
| 2 | Bundle ID | Your app's permanent identity |
| 3 | APNs key (`AuthKey_XXXXXXXXXX.p8`) and its key ID | The relay, to send push |
| 4 | App Store Connect API key (another `.p8`), its key ID, and issuer ID | fastlane, to make profiles |
| 5 | Distribution certificate (`.p12`) and its password | fastlane, to sign the app |
| 6 | Your iPhone's UDID | Installing a test build |

Items 3 and 4 are two different keys, and both are `.p8` files. Keep them apart. Apple lets you download each **only once**, so store them somewhere safe and private. Never put any of them in the repository: Git already ignores `.p8` and `.p12` files.

1. **Team ID.** [developer.apple.com/account](https://developer.apple.com/account), under Membership details. Ten characters, such as `ABCDE12345`.
2. **Bundle ID.** Choose it now, in reverse-domain form, such as `com.company.support`. You do not register it by hand: fastlane does it in [step 8](#8-build-your-app). It cannot change once the app is on the App Store.
3. **APNs key.** [Certificates, Identifiers & Profiles > Keys](https://developer.apple.com/account/resources/authkeys/list), then **+**. Name it, tick **Apple Push Notifications service (APNs)**, and configure it as **Sandbox & Production**, **Team Scoped (All Topics)**. Continue, register, and download the `.p8`. The key ID is in its file name, `AuthKey_<key ID>.p8`. Apple allows only a few APNs keys per team. If yours already has a team-scoped one, you can use it.
4. **App Store Connect API key.** [App Store Connect > Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api), then **+** under Team Keys. Give it the **App Manager** role (if fastlane later cannot register the bundle ID, make one with **Admin**). Download the `.p8`, and note its key ID and the **Issuer ID** shown above the list.
5. **Distribution certificate.** If your team already has an Apple Distribution certificate on this Mac, export it as in the last part of this item. Otherwise:
   - Open **Keychain Access**, then **Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority**. Enter your email, choose **Saved to disk**, and save the request.
   - [Certificates > +](https://developer.apple.com/account/resources/certificates/add), choose **Apple Distribution**, upload the request, and download the `.cer`. Double-click it, so that it joins your keychain.
   - In Keychain Access, under **My Certificates**, find **Apple Distribution: \<your team\>**, right-click it, choose **Export**, save as `.p12`, and set a password.
6. **iPhone UDID.** Connect the iPhone by cable, open Finder, select the iPhone, and click the line under its name until it shows the UDID. Right-click to copy it. Then [Devices > +](https://developer.apple.com/account/resources/devices/add), and register it.

## 7. Deploy your relay

The relay sends your app's notifications through Apple, with your APNs key. It runs on your Cloudflare account, beside the backend.

```bash
pnpm oc relay deploy --env production
```

You should see, at the end:

```text
Relay: https://oc-production-relay.<subdomain>.workers.dev
Relay ID: production
```

Load your APNs key into it, with the values from step 6. The `.p8` here is the **APNs** key, item 3:

```bash
pnpm oc relay set-apns --env production \
  --team-id ABCDE12345 --key-id KEY1234567 \
  --key-file ~/private/AuthKey_KEY1234567.p8 \
  --bundle-id com.company.support
```

The key goes straight from the file into a Cloudflare secret. It is not printed or copied anywhere else. You should see `Apple accepted the key.` If you see `Apple refused the key`, check the team ID, the key ID, and that you gave the APNs key, not the App Store Connect one.

Admit your backend to the relay. Its installation ID is in its discovery document:

```bash
curl -s https://oc-production.<subdomain>.workers.dev/.well-known/openchat.json
```

Copy the `installationId`, which starts with `inst_`, and:

```bash
pnpm oc relay allow --env production --installation inst_...
```

Then point the backend at the relay, with the relay address and ID from above:

```bash
pnpm oc deploy --env production \
  --relay-url https://oc-production-relay.<subdomain>.workers.dev \
  --relay-id production --relay-bundle-ids com.company.support
```

You should see `Deployed` again. The backend remembers these settings for later deploys.

## 8. Build your app

Make your app's settings, which hold only public values. Use your own 1024 by 1024 PNG icon with no transparency, or leave out `--icon` and `--splash` to use OpenChat's for now:

```bash
pnpm oc app variant --id company --name "Company Support" --bundle-id com.company.support \
  --relay-env production --color '#0f766e' --icon ./icon.png --splash ./splash.png
```

You should see `Made apps/mobile/variants/company`, and `Push goes only through https://oc-production-relay...`.

Give fastlane your Apple details. In `apps/mobile`:

```bash
cd apps/mobile
cp fastlane/.env.example fastlane/.env
open -e fastlane/.env
```

Fill in every line, with full paths to the files. `ASC_KEY_PATH` is the **App Store Connect** key, item 4, not the APNs key. Save it. Git ignores this file.

Then make a profile, build, and install, with the iPhone connected by cable and unlocked:

```bash
APP_VARIANT=company fastlane ios refresh_profile
APP_VARIANT=company fastlane ios device
APP_VARIANT=company fastlane ios install
```

`refresh_profile` registers your bundle ID with Apple, turns on push for it, and makes a profile that lists your registered devices. `device` takes several minutes, and should end with `Built build/ios/CompanySupport-adhoc.ipa`. `install` puts it on the iPhone. If the iPhone refuses to open it, go to **Settings > Privacy & Security > Developer Mode**, turn it on, and restart.

## 9. Try it

1. Open your app on the iPhone. For **Address**, enter `oc-production.<subdomain>.workers.dev`, then sign in.
2. Allow notifications when asked.
3. In the app, open **Settings**. You should see **Notifications** with switches, and no message saying they are unavailable.
4. Lock the iPhone. From your website's chat widget, send a message.

You should see a notification on the iPhone within a few seconds. Tap it, and the conversation opens. Reply from the app, and the reply appears in the widget.

To send the app to testers through TestFlight, or to the App Store, see [build profiles](../ios-build/expo-and-white-label.md#building).

### With the official OpenChat app

The official OpenChat app can also connect to your backend, and messaging works fully. It cannot use your relay, because it only sends its device token to relays built into it, so it has no push. Its Settings say: "This installation uses a notification service this app cannot use. Messages still arrive in the inbox."

## 10. Keep it up to date

When a new release comes out, read its notes, then:

```bash
git fetch --tags
git checkout <new tag>
pnpm install --frozen-lockfile
pnpm oc upgrade --env production
pnpm oc relay deploy --env production
```

`oc upgrade` records how to undo itself before changing anything, and puts the old version back by itself if the new one is unhealthy. If you find a problem later, `pnpm oc rollback --env production` puts the previous version back. See [upgrades](deployment.md#upgrades-oc-upgrade).

Rebuild the app only when the release notes say the app changed.

## When something goes wrong

| You see | Do |
|---|---|
| `oc preflight` marks something `FAIL` | Its line says what to do. Nothing was created, so fix it and run it again |
| A deploy stops part way | Run the same command again. It resumes, and creates nothing twice |
| `already exists, and this deployment did not create it` | Something on the account already has that name. Choose another `--env` name |
| `The deployment did not become healthy`, and login is erroring | The account is not on Workers Paid |
| The widget does not appear on your site | The page's address must match an allowed origin exactly, including `https://` and `www`. If the site has a content security policy, it must allow your backend's address for scripts and connections |
| `Apple refused the key` | Wrong team ID or key ID, the App Store Connect key given instead of the APNs key, or a key limited to sandbox |
| fastlane cannot register the bundle ID | The App Store Connect key needs the App Manager or Admin role |
| `No profile. Run: fastlane ios refresh_profile` | Run it, with the same `APP_VARIANT` |
| `install` times out | Use a cable, and unlock the iPhone |
| The app's Settings say notifications are unavailable | The relay in the app's variant must match the backend's `--relay-url` and `--relay-id` exactly. Check `curl .../.well-known/openchat.json` against `apps/mobile/variants/<id>/variant.json` |
| Notifications are on, but none arrive | Check that the backend is admitted (`oc relay allow`), and that `pnpm oc relay check --env production` says Apple accepted the key |

## Removing everything

There is no single command yet. In the Cloudflare dashboard, or with `pnpm --filter @openchat/api exec wrangler`, delete in this order, because Cloudflare refuses otherwise: each queue's consumer, the Workers `oc-production` and `oc-production-relay`, the queues, the R2 bucket `oc-production-attachments`, and the D1 databases `oc-production` and `oc-production-relay`. Deleting a Worker can go on failing for a few minutes after its consumers are removed, with error 10064. Wait and try again. Then delete `.openchat/production`.
