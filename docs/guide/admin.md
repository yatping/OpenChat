# Administration

For installation admins. The first admin is the person `oc deploy` set up. Admin pages are in the dashboard's top bar: **People**, **Workspaces**, **Failed jobs** and **Audit log**.

Being an admin lets you change settings, not read conversations. To read a workspace's conversations, add yourself to it on the People page, which the audit log records.

## People

**Add someone.** Enter their name and email, then **Add**. OpenChat emails them a link to choose a password, which lasts seven days. Then add them to a workspace, as an agent or a supervisor. Without a workspace they can sign in but see nothing.

This needs email. Without it, run `pnpm oc recover --env <name> --email <address>` on the computer you deploy from, which prints a reset link to pass on yourself.

For each person you can:

| Action | What it does |
|---|---|
| **Add to workspace**, and change the role | Agent or supervisor, for each workspace. See [roles](README.md#how-it-fits-together) |
| **Remove** from a workspace | Ends their access there. Their messages keep their name. Undo by adding them again |
| **Make admin**, **Remove admin role** | Gives or takes the admin role. Be sparing: every admin has power over every workspace |
| **Deactivate account** | Signs them out everywhere and stops them signing in. Their messages stay, with their name. **Reactivate account** undoes it |

Nobody can delete an account. That keeps the history of who said what. A former colleague's name cannot be erased yet; see [known issues](../known-issues.md).

## Workspaces

Choose a workspace under **Workspace to manage**. Creating one with **Create workspace** does not add you to it.

### Websites

Each website has its own chat button. **Add a website** with a name and its **allowed origins**: the exact addresses of the sites it may appear on, one per line, such as `https://www.company.com`. No paths and no wildcards. The widget refuses to load anywhere else.

Each website's card has the snippet to paste into the site. See [the website widget](widget.md) for that, and for these **Widget** settings:

| Setting | Choices |
|---|---|
| Welcome message | Up to 500 characters, shown as written, in any language |
| Colour | The chat button and the panel's accents |
| Ask for an email | **Never**, **Offer it, after the first message**, or **Before the first message** |
| Widget language | **Automatic**, or one of eleven languages |
| Show agents' names to visitors | Off by default, so visitors see "Support", in their language |
| Check that new visitors are people | Cloudflare Turnstile, when a new visitor first writes. Needs keys set at deploy time |

The widget picks up a change within a minute.

### Retention

**Keep closed conversations** decides how long resolved and archived conversations stay: **Forever**, the default, or 30 days to two years after their last message. Once one is older, it is deleted with its messages and files, within the hour, and cannot be recovered from OpenChat. Contacts left with no conversations go too. Open and pending conversations are never deleted this way. Each run is in the audit log.

Shortening it asks you to confirm, because older conversations start going within the hour. See [privacy and data](privacy.md#how-long-data-is-kept).

### Push notifications

Shows whether the installation is connected to a notification relay, and how many phones have registered. **Disconnect and erase** turns push off for everyone, and asks the relay to erase what it holds about the installation: its address, its workspace names, and an ID for each phone. **Reconnect** turns it back on.

## Follow-up emails

In each workspace, on its **Email** tab, a supervisor can add follow-up rules: send one email when an open conversation has had no messages for a set time, such as 60 minutes. It goes only to visitors who gave an email address and ticked the box to allow it. It has a fixed text, with no message content, and a link to unsubscribe.

**Addresses not to email** lists who will get no more follow-ups, and why: unsubscribed, bounced, marked as spam, or added by hand. You can add an address, and remove those added by hand.

Email has to be set up when OpenChat is deployed; see the [self-hosting guide](../operations/self-hosting.md#optional-email).

## Failed jobs

Background work, such as sending a push notification or an email, is retried several times. If it still fails, it is listed here, by kind, with the time and the number of attempts. Fix the cause, for example the email settings, and then **Replay**, or **Dismiss** a job you no longer need. Work a job already finished is not repeated. Some jobs cannot be replayed, because the time they had to run by has passed. Failed jobs are kept for 90 days.

## Audit log

What admins did, and what the system did on their behalf: people and roles, workspaces and websites, someone adding themselves to a workspace, contacts exported or erased, replays and retention runs. Newest first, for **Everything** or one workspace. It names your colleagues, but never a visitor, and never holds message content. Only admins can read it. Retention does not delete it.

## Keeping the installation healthy

Upgrades, backups, health checks and alerts are run from the computer you deploy from, by whoever operates the installation. See:

- [Monitoring](../operations/monitoring.md): `pnpm oc health`, and what to alert on.
- [Backup and restore](../operations/backup-and-restore.md): `pnpm oc backup` and `pnpm oc restore`.
- [Upgrades](../operations/self-hosting.md#11-keep-it-up-to-date): `pnpm oc upgrade`, and `pnpm oc rollback`.
