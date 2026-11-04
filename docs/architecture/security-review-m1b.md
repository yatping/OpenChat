# Security review: core messaging (M1b)

Required by [Milestone 1b](../plan/milestones.md#m1b-core-messaging-xl), for tenant isolation, visitor tokens, attachments, and XSS. Reviewed on 2026-11-04 by the implementing agent, reading the code and attacking real deployments from outside. **This is not an independent review, and it should not be counted as one.** The same author wrote the code and chose the attacks.

## Result

Four defects found and fixed, plus one smaller bug. No way was found across a tenant boundary, to an internal note from the visitor side, or to run script through a message, name, or file. **Finding nothing is weaker evidence than it sounds, for the reason above.**

## Fixed during this review

| Severity | Finding | Fix |
|---|---|---|
| Medium | **A script could reach an agent's desktop by name.** `invoice.bat` or `invoice.html` passed as `text/plain`, and `photo.exe` as a PNG, so type and content agreed and the name did not. An agent opens a saved file by its name | The extension must match the declared type, from a short list. Characters that reorder or hide text are removed from names |
| Medium | **Anyone could flood the shared database.** A session is free to get, and profile and read-position writes had no limit, while one database tops out at [about 45 writes a second](cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04). One script could degrade every tenant on an installation | 120 requests a minute per visitor, checked before the database. 1,200 of those writes a minute per website |
| Medium | **Sockets outlived a suspected theft.** A password reset, CLI recovery, or refresh token reuse ended sessions, but an open socket kept receiving messages until its 15 minutes ran out | These now close the member's sockets, within about two minutes through the sweep |
| Low | **A ticket could open any number of sockets.** It is reusable for its 30 seconds, while `realtime.md` said it granted only one connection | Ten sockets per visitor in a room. The document now says what happens |
| Low | Hono's `/conversations/*` also matches `/conversations`, so that route authorised twice per request, with two database reads | Registered once. Found because the new limit counted double |

## What was attacked on a real deployment

From outside, on throwaway Workers with real D1, R2, and Durable Objects, all removed afterwards. 83 checks in one run, of which one failed because of the script: 135 sequential writes took over a minute, so the window reset. Repeated properly, below. The other team was a second workspace seeded in D1, which the signed-in owner did not belong to.

| Area | Attack | Result |
|---|---|---|
| Between visitors | Read, send, ticket, read position, and upload in another visitor's conversation | 404 |
| Between workspaces | List, read, reply, ticket, websites, and members in the other workspace, and reaching its conversation through one's own | 404, with no content |
| Between workspaces, live | Listening on one's own hub while the other team talks, and sending typing with its conversation ID | Nothing crossed either way |
| Tokens | `alg: none`, swapped payload, removed signature, extended expiry | 401 |
| Tokens | Visitor token on agent routes, agent token on visitor routes, a ticket as either | Refused |
| Tokens | One website's refresh token on another | A new visitor, not a resume |
| Sockets | A forged claims header with a bad ticket, and a real ticket from a wrong page | Not opened |
| Origin | Other sites, a suffix match, `http`, a port, `null`, none, and a real token from a wrong page | 403 |
| Notes | A note with a file, watched by REST and socket | Never seen, no gap in sequence, and `lastSeq` does not count it |
| Notes | Replaying a note's client ID, claiming or downloading its file | 409, 400, and 404, with nothing revealed |
| Files | HTML, SVG, a page or batch file as text, a program as a picture, double extensions, and a reversing character | 415 |
| Files | A PNG with HTML after its signature | Accepted. Served as `image/png` with `nosniff`, a sandbox CSP, and `no-store` |
| Files | A line break or path in a name, over 25 MB, another visitor's file, no token | Cleaned, 413, 404, and 401 |
| Injection | SQL in a path and in a message | 404, and stored as words |
| Limits | 160 profile writes, 20 at a time | 120 accepted, 40 got 429, and another visitor unaffected |
| Limits | Sockets from one ticket, messages per minute, sessions per address | Stopped at 10, 20, and the hourly limit |
| Theft | Refresh token reuse, and a real `oc recover` followed by its link | Socket closed with 4403, after 102 s and 93 s, through the real cron |

XSS is covered by a browser test that runs on every change. Markup in a message, a name, and a file name, in both directions between widget and inbox, stays text, runs nothing, and makes no element. Reading the code found no `innerHTML` with outside data, and no links built from it. The widget's one `innerHTML` is a constant icon.

Roles were not attacked from outside, because this deployment had one user. Each route's capability check was read, and is covered in workerd.

## Accepted trade-offs

| Behaviour | Why it is accepted |
|---|---|
| A ticket works more than once for its 30 seconds, and may appear in Cloudflare's own request logs, since it is in the URL. Not checked | Single use needs shared state on every connect. It is bound to its page and capped per visitor, and it lasts 30 seconds |
| A socket can last up to two minutes after a revocation, when the sweep runs | The same as removing a member, since commit comes before broadcast |
| Signing out of one device leaves that person's other sockets open, up to 15 minutes | Sockets are not tied to a session, and signing out is not a sign of theft |
| After an allowed origin is removed, an open visitor socket lasts up to an hour, and bootstrap up to 30 seconds | REST checks on every request. The origin list protects against other sites embedding the widget, and is not authentication |
| Visitors can use up a website's own limits, shutting other visitors of that website out | That is the limit working, and it keeps other websites safe. Turnstile raises the cost |
| A visitor's name and email are unverified, and an agent sees whatever they typed | Shown as unverified text. Never merged automatically |
| The Turnstile hostname is not checked by the Worker | Cloudflare checks it against the widget's list, which must include every website using the installation's key |

## Gaps to close later

| Gap | Risk | When |
|---|---|---|
| **No cap on total stored data.** At the limits, one website can take 600 messages a minute of 16 KB, about 14 GB a day against D1's limit per database, and about 12 GB of files an hour | One address can reach that rate, with 30 sessions from one hour at 20 messages a minute each, and could then fill D1 in about a day and stop every tenant writing. Turnstile raises the cost, if a website turns it on | **Before general release.** See the decision below |
| No alert when any of this happens | The operator finds out when writes fail | M5 |
| Visitor refresh tokens never expire or rotate, and cannot be revoked | One stolen from a host page works until the visitor is deleted. It reaches only that visitor's conversations | Before general release |
| Resuming a session counts toward 30 an hour per address | 30 returning visitors behind one office address would be turned away. Fails safe, and is an availability problem | Watch for reports, and consider separating resumes from new visitors |
| Visitors who never write are never deleted, when made directly through the API | Slow growth, limited per address and per website | With the retention sweeps |
| No malware scanning of files | A ZIP or PDF can still carry anything, and the type check only proves what it claims to be | Consider for M5. Agents should treat files as they would any email attachment |
| A CSV can carry spreadsheet formulas | Run by a spreadsheet, not by OpenChat | Document for agents, and consider a warning in the inbox |
| A hostile image can use a lot of memory to display | Could slow an agent's tab | Low. Previews are only for raster images |
| Only Chromium was tested | | Before release |

## Decisions for the owner

1. **Should a website have a daily storage budget?** I recommend one before anyone runs this for strangers, because the database is shared by all its tenants. It means choosing a number, and a busy site would need to be able to raise it.
2. **Get an independent review before general release.** Both this review and [the M1a review](security-review-m1a.md) are by the implementing agent.
