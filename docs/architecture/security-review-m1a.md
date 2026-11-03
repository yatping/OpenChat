# Security review: authentication and session handling (M1a)

Required by [Milestone 1a](../plan/milestones.md#m1a-accounts-workspaces-deployment-l). Reviewed on 2026-11-04 by the implementing agent, reading the code and testing a real deployment. **This is not an independent review.** The author checked their own work, so an outside review before real customer use is still worthwhile.

## What was tested on a real deployment

All of these passed from outside, against a Worker on Cloudflare:

- The owner's one-time link works once, and CLI recovery revokes existing sessions at once.
- Refresh rotates. Reuse is refused, revokes the newer token, and ends the access token immediately.
- Two concurrent refreshes on real D1: one wins, and the session is revoked.
- The dashboard cookie has its attributes, a cookie refresh from another origin gets 403, and scripts cannot read the cookie.
- The eleventh login attempt gets 429 with `Retry-After`, from the real Durable Object.
- Another tenant gets 404. The last owner cannot be demoted.
- The strict CSP is served on the shell and on SPA routes, with no violations during sign-in.

## Login timing

Measured from outside with wrong passwords, alternating between groups, 11 samples each. Every sample was a 401 that ran real scrypt.

| Attempt | Known account, median | Unknown account, median |
|---|---|---|
| First on that address | 1081 ms | 1007 ms |
| Repeat on that address | 457 ms | 525 ms |

**No difference between known and unknown accounts stands out from the noise, and the direction reverses between rows.** With 11 samples and spreads of hundreds of milliseconds, this cannot rule out a small difference. An attacker averaging many samples is limited by the throttles: 10 attempts per account and 50 per address per 15 minutes.

An earlier run appeared to show a 300 ms difference. That run used fresh addresses for one group and reused addresses for the other, and the first attempt on any address takes about 500 ms longer in both groups, most likely from creating its `AuthGuard` object. That would reveal whether an address was tried recently, not whether an account exists.

## Fixed during this review

| Finding | Fix |
|---|---|
| Token responses had no `Cache-Control: no-store` | Added to all `/api/*` responses, with `nosniff` |
| `oc deploy` reported a healthy deployment as failed when the operator's address was rate limited | A 429 now counts, because the signing key loads before the limiter |

## Accepted trade-offs

| Behaviour | Why it is accepted |
|---|---|
| Anyone can block an account's password login for 15 minutes by failing on purpose | Throttling needs a per-account key. Existing sessions keep working, and reset still works |
| Anyone can use up an address's three reset emails per hour | This prevents mail-bombing. CLI recovery still works, but a person with no operator must wait |
| A successful login clears that account's failed attempts | An attacker guessing while the user signs in gets a few more attempts, still bounded by the per-address limit |
| Successful logins count toward the limit of 50 per address per 15 minutes | Simple, and only a large team behind one address would notice. Review it if anyone reports this |
| One-generation reuse detection | An older stolen token cannot be used, and simply fails without revoking |
| A lost refresh response signs the client out | It fails safe |
| Sessions slide with no absolute maximum | As specified. An active stolen token is limited by rotation and reuse detection |

## Gaps to close later

| Gap | When |
|---|---|
| Nothing deletes expired `auth_sessions` and `auth_tokens` rows | With the retention sweeps in a later milestone |
| No signed-in password change. Users change a password through reset | Add before general release |
| No UI or command to list and revoke sessions | M5 |
| No command to rotate signing keys, though the format supports it | M5 |
| `workers.dev` stays reachable when a custom domain is used | M5, as part of domain setup |
| Nothing issues email-verification tokens yet, and nothing depends on verification | When a feature first needs it |

## Decisions for the owner

1. **Should `DELETE /api/v1/me` ask for the password again?** It needs only a bearer token, as the draft API specifies, so a stolen access token could delete the account within its 15 minutes. **Recommendation: yes**, since the operation can't be undone. This is a small contract change.
