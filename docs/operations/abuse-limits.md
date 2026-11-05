# Abuse limits

These limits stop a stranger on the internet from filling the database that all of an installation's tenants share. Anyone can reach the widget API without an account, so limits are the main defence.

## What you can change

Four settings apply to every website on an installation. The defaults suit most installations.

| Setting | Default | Allowed | `oc deploy` flag | Worker variable |
|---|---|---|---|---|
| Visitor messages per website, per day | 20,000 | 1 to 10,000,000 | `--messages-per-website-per-day` | `LIMIT_MESSAGES_PER_WEBSITE_PER_DAY` |
| Visitor messages per address, per minute | 60 | 1 to 100,000 | `--messages-per-ip-per-minute` | `LIMIT_MESSAGES_PER_IP_PER_MINUTE` |
| Longest visitor message, in characters | 4,000 | 1 to 16,000 | `--message-max-chars` | `LIMIT_MESSAGE_MAX_CHARS` |
| How much of an IPv6 address counts as one address | /64 | /32 to /128 | `--ipv6-prefix` | `LIMIT_IPV6_PREFIX` |

## How to change a setting

Pass the flag to `oc deploy`:

```sh
pnpm oc deploy --env acme --owner-email you@example.com --messages-per-website-per-day 50000
```

- The value is saved in `.openchat/<env>/state.json`, so later deploys keep it. Pass `default` to go back to the default.
- A value outside the allowed range stops the deploy with an error.
- A change applies from the first request after the deploy. It does not restart a count, so raising the daily limit lets a stopped website carry on straight away.
- Do not change these variables in the Cloudflare dashboard, because the next `oc deploy` overwrites them. If a variable holds an unusable value anyway, the Worker uses the default, so a typing mistake cannot turn a limit off.
- For local development, set the variable in `services/api/.dev.vars`.

Workspace owners cannot change these settings, and they are not in any API. One tenant raising its own limit could fill the database for everyone else.

## What people see

| Limit reached | API response | What the widget says |
|---|---|---|
| Longest message | 400 `message_too_long` | The text box stops accepting text at the limit, which it gets from the widget bootstrap response |
| Messages per address, or any other speed limit | 429 `rate_limited`, with `Retry-After` | "That was a lot of messages. Please wait a moment and try again." |
| Messages per website, per day | 429 `daily_limit_reached`, with `Retry-After` | "This chat cannot take more messages today. Please try again later." |

Agents are never counted and can keep replying. Other websites are not affected.

## How the limits are counted

**The day** is 24 hours from the website's first counted message, not a calendar day. `Retry-After` gives the seconds left.

**Refused messages.** A message that a speed limit refuses does not count toward the day. Once the daily limit is reached, further attempts are refused until the 24 hours end.

**Addresses.** Every limit by address uses the same rule, including login, password reset, and new visitor sessions. A lint rule rejects a limit by address that does not.

- An IPv4 address is counted as it is.
- An IPv6 address is cut to its first 64 bits, because one home or mobile connection usually holds a whole /64, which is billions of addresses. Counting each one separately would limit nothing.
- Different ways of writing an address count as the same address, and an IPv4 address written as IPv6 counts as that IPv4 address.

Some providers give a customer a /56 or /48. Lower the prefix to count those as one, but remember that everyone in that range then shares one limit.

## Why these defaults

A D1 database holds at most 10 GB, and when it is full, writes stop for every tenant. The [load test](../architecture/cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04) measured about 1 KB of database per message, even for very short ones. A message's text is stored on top of that.

| One website at 20,000 messages a day | Size per message | Per day | Days to fill 10 GB |
|---|---|---|---|
| Short messages | About 1 KB | About 20 MB | About 500 |
| 4,000 characters of English text | About 5 KB | About 100 MB | About 100 |
| 4,000 characters of Chinese or Japanese text, the worst case | About 13 KB | About 260 MB | About 38 |

These sizes are estimates built from that measurement. The worst-case row has not been measured on its own.

## What a reached limit costs

The daily limit protects the database by stopping that website's chat, which means an attacker can stop a website's chat on purpose:

- From one address, at 60 messages a minute, a website's 20,000 messages last about 5.5 hours.
- From ten or more addresses, at the limit of 600 a minute per website, they last about 33 minutes.

The chat then refuses visitors for the rest of the 24 hours. Raising the limit is the way to bring it back.

**Noticing it:** the Worker writes a `website_daily_limit_reached` warning to its logs, with the workspace and website IDs, each time it refuses a message. Nothing alerts you or the workspace owner yet, and the dashboard does not show it. Alerts are planned for M5, and until then you need to watch the logs:

```sh
pnpm oc render --env acme --service api
pnpm --filter @openchat/api exec wrangler tail oc-acme --format json -c ../../.openchat/acme/api.wrangler.jsonc
```

## What these limits do not cover

- **Files.** They go to R2, not the database, and have their own limits of 20 uploads an hour per visitor and 500 per website. At those limits a website could store about 12 GB an hour. That is a cost to the operator, not an outage for other tenants, and there is no daily limit on it yet.
- **Other visitor writes**, such as profile changes and read positions. These have a speed limit of 1,200 a minute per website, but no daily limit.
- **Several websites.** Each website has its own 20,000 a day. An attack on many websites at once uses the database faster, and a workspace owner can create more websites.
- **Agent messages**, which need an account.

## Limits set in code

These are not settings. They are in `LIMITS` in `packages/core/src/auth-flows.ts`.

| Limit | Value |
|---|---|
| Login attempts per account | 10 per 15 minutes |
| Login attempts per address | 50 per 15 minutes |
| Password reset requests per email | 3 per hour |
| Password reset requests per address | 20 per hour |
| Token confirmations per address | 20 per 15 minutes |
| New accounts per installation admin | 30 per hour |
| New visitor sessions per address | 30 per hour |
| New visitor sessions per website | 3,000 per hour |
| Messages per visitor | 20 per minute |
| Messages per website | 600 per minute |
| Requests per visitor | 120 per minute |
| Other visitor writes per website | 1,200 per minute |
| Uploads per visitor | 20 per hour |
| Uploads per website | 500 per hour |

## How far this has been tested

Everything above has automated tests. On a real Cloudflare deployment on 2026-11-05 we checked the message length, the limit per address over IPv4, the daily limit, changing settings by redeploying, the widget's message, and the log line. See the [results](../architecture/cloudflare-validation.md#abuse-limits-on-real-cloudflare-2026-11-05).

**IPv6 grouping has not been tested on real Cloudflare**, because the network it was tested from has no IPv6. Its tests send the `cf-connecting-ip` header directly.
