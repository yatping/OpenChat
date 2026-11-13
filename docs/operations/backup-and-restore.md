# Backup and restore

How to back up an OpenChat installation's database, and how to restore it. It assumes a deployment made with `pnpm oc deploy`, as [deployment](deployment.md) describes. Each command here was rehearsed on a real deployment; the [rehearsal](#rehearsal) says what happened.

## What there is to lose

| What | Where | Covered by |
|---|---|---|
| Conversations, messages, contacts, accounts, settings, audit log | D1 | Time Travel for 30 days, and `oc backup` for as long as you keep the file |
| Attachments | R2, `oc-<name>-attachments` | **Neither.** See [attachments](#attachments) |
| Secrets: signing keys, the operator token, the email provider's key | Worker secrets, which cannot be read back. The operator token is also in `.openchat/<name>/` | Neither. See [restoring elsewhere](#restoring-to-another-account) |
| Which resources belong to the deployment | `.openchat/<name>/state.json` on the computer that deployed | Back up `.openchat/` yourself. It is small |
| Live connections, rate limit counters | Durable Objects | Nothing to back up. They rebuild themselves |

## Two ways back

**Time Travel** is built into D1. It can put the database back to any minute in the last 30 days, on Workers Paid, in place. It needs no preparation, so it is the first thing to reach for. It cannot go further back than 30 days, and it cannot help if the database itself is deleted.

**`oc backup`** writes a full SQL export of the database to a file on your computer. Keep the file as long as you like, and away from Cloudflare. Restoring one creates a new database, and the Worker switches to it; the old database is kept.

Both discard every write made after the point you go back to. Prefer a forward fix when you can.

## Backing up

```sh
pnpm oc backup --env acme
```

```text
Exporting oc-acme. Other requests wait while it runs.
Checking the backup by loading it into a throwaway local database

Backed up acme: 2.1 MB, 31 tables, 14210 rows, migration 0013_audit_log_recent.sql
  /home/you/openchat/.openchat/acme/backups/acme-20261113-0243.sql
```

1. Records a Time Travel bookmark from just before the export.
2. Exports the schema, then the data, with `wrangler d1 export`, and the schema once more. **The database answers nothing else while an export runs**, so run it when the inbox is quiet. A small database takes about 20 seconds in all. If the schema changed between the first and last export, an upgrade ran, and the backup is refused.
3. Writes one file: the schema, then the rows, with each table's rows after those of the tables it refers to. See [why](#why-not-wranglers-export-as-it-is).
4. Loads the file into a throwaway local database, checks every foreign key, counts every table, then deletes that copy. A file that does not load, has a row that refers to a missing row, or holds no installation, is not called a backup.
5. Writes a manifest beside it, `acme-20261113-0243.json`, with the bookmark, the release, the newest migration, the row count of each table, and a SHA-256 hash. It holds no content.

Files go to `.openchat/<name>/backups/`, which Git ignores, or to `--out <directory>`. The directory is made readable only by you, and so are both files.

**A backup holds every message, contact and email address in the installation, and password hashes.** Treat it like the database:

- Copy it somewhere away from this computer and from your Cloudflare account, encrypted. For example, `age -r <recipient> acme-20261113-0243.sql > acme-20261113-0243.sql.age`. Keep the manifest with it.
- Delete old backups on a schedule. A contact you [erased](../architecture/data-model.md#contact-export-and-erasure) is still in every backup made before the erasure, until the backup is deleted. Say so in your privacy policy, with how long you keep backups.
- To back up on a schedule, run `oc backup` from a machine you control, such as a nightly cron job, with Wrangler logged in or `CLOUDFLARE_API_TOKEN` set.

## Restoring

Every restore needs `--confirm` followed by the deployment's name, and prints how to undo itself.

### With Time Travel, in place

```sh
pnpm oc restore --env acme --timestamp 2026-11-12T09:00:00Z --confirm acme
pnpm oc restore --env acme --bookmark <bookmark> --confirm acme
```

A backup's manifest, and `oc upgrade`, record bookmarks. A timestamp is any RFC 3339 time, or Unix seconds, in the last 30 days.

1. Records the bookmark of the database as it is now, in `state.json`, and prints the command that goes back to it.
2. Restores in place with `wrangler d1 time-travel restore`. The database is unavailable for the few seconds this takes.
3. Checks that the deployment is healthy, as `oc deploy` does.

To undo it, restore to the bookmark printed in step 1.

### From a backup file

```sh
pnpm oc restore --env acme --from .openchat/acme/backups/acme-20261113-0243.sql --confirm acme
```

1. Checks the file against its manifest's hash, and that it is a backup of this deployment. Nothing is created if either fails.
2. Creates a new database, `oc-acme-<date>-<time>`, and loads the file into it.
3. Counts every table, and compares the counts with the manifest. If any differ, stops: the Worker still uses the old database.
4. Switches the Worker to the new database, applies any migrations newer than the backup, deploys, and checks health. If the check fails, switches back, and says so.
5. Records the old database in `state.json`. It is kept, unchanged, with every write made before the switch.

Most of the time is creating the database and deploying the Worker: 39 seconds for a small one in the rehearsal.

To go back to the old database:

```sh
pnpm oc restore --env acme --database oc-acme --confirm acme
```

When you are sure you no longer need it, delete it with `wrangler d1 delete`. Until then it counts against the account's storage.

After a switch, every OpenChat command uses the new database. Time Travel works on it from the moment it was created; bookmarks recorded before the switch belong to the old database.

After switching back, `/health/queues` fails with `heartbeat_stale` for up to a minute: the old database received no heartbeats while it was set aside. The next one clears it.

## What a restore does not put back

| What | After a restore |
|---|---|
| Messages and changes made after the restore point | Gone from the database the Worker uses. After `--from`, they are still in the old database, which is kept |
| Sessions | Those that existed at the restore point work again, until they expire. Later sign-ins are lost, so people sign in again |
| Phones | A phone that registered for push after the restore point is unknown to the database again, so it gets no push until the app registers again |
| Email | Unsubscribe links sent after the restore point no longer work, because the database no longer holds them |
| Retention, erasure | A contact erased after the restore point is back. **Erase them again**: the audit log of the old database, or of the backup, shows who |
| Audit log | Goes back with everything else. The restore itself is not in it, since the CLI acts on Cloudflare, not through the API. Record it yourself |

### Attachments

Attachments are in R2, which has no Time Travel and is not in a backup. A restore brings back the database rows that point to them:

- an attachment deleted after the restore point, for example by retention, is gone, and its link answers 404;
- an attachment uploaded after the restore point stays in R2, with nothing pointing to it.

To keep copies of attachments too, use R2's S3-compatible API with a tool such as `rclone`, with a token that can read only this bucket. OpenChat does not do this for you.

### Restoring to another account

Not supported yet. A backup holds the database only, and Worker secrets cannot be read back. A new deployment would have a new signing key, so everyone signs in again, and a new relay signing key, which the relay would refuse until key rotation exists. To prepare, keep `.openchat/<name>/` and your backups somewhere other than the Cloudflare account.

## Rehearsal

To do on the release candidate of each release, and whenever these commands change. Use a preview deployment, never a real one.

1. Deploy a preview, sign in, and create a workspace, a conversation with a reply, an internal note, and a contact.
2. `oc backup`. Check the manifest's counts.
3. Change data: send a message, delete the contact.
4. `oc restore --timestamp`, to a minute before step 3. Check the message is gone and the contact is back. Undo it with the printed command, and check step 3's changes are back.
5. `oc restore --from` the backup. Check the counts it reports, sign in, and read the conversation. Check the old database still exists.
6. `oc restore --database` back to the old database.
7. Tear the preview down, including the database the restore created.

### Results

On 2026-11-13, on `preview-bk`, release 0.2.1, with Wrangler 4.157.0. The data was a website, a visitor's conversation with a reply and an internal note, a contact, and a second conversation whose message held a line break, a carriage return and a quotation mark.

| Step | Result |
|---|---|
| `oc backup` | 31 tables, 49 rows, 35 KB, in 22 seconds. Files mode 600 in a directory mode 700 |
| Send a message, erase the contact | The conversation answered 404 |
| `oc restore --timestamp`, to before that | 8 seconds. The conversation was back, with every message and the note. Sign-in worked |
| Undo, with the bookmark it printed | The erasure and the later message were back |
| `oc restore --from` the backup | 39 seconds. Every table's count matched. The message with line breaks was byte for byte the same. All four [health checks](monitoring.md) were OK, and heartbeats kept arriving |
| `oc restore --database` back | The erasure was back. `heartbeat_stale` for under a minute, as above |

The first attempts found two faults, both now fixed and tested:

- Wrangler's export did not load at all, locally or remotely. See below.
- With the schema first, the file loaded locally, but D1's remote import refused it with `FOREIGN KEY constraint failed`, and rolled itself back. `oc restore` stopped before switching, and the Worker kept the old database, as designed.

### Why not Wrangler's export as it is

`wrangler d1 export` writes each table's `CREATE TABLE` followed by its rows, in alphabetical order. So the rows of `attachments` arrive before the `workspaces` table exists, and loading fails with `no such table: main.workspaces`. Exporting the schema and the data apart, and joining them schema first, fixes loading into a local database.

D1's remote import is stricter. Although the export starts with `PRAGMA defer_foreign_keys=TRUE`, a file of 124 statements with child rows before their parents was refused. A file of five statements in the same order was accepted, so the size or batching of the import seems to matter; Cloudflare does not document it. Putting each table's rows after those of the tables it refers to was accepted. A table that refers to itself, such as a contact merged into another, keeps the order the export wrote; if that ever fails, `oc restore` stops before switching, as above.

The data export writes one statement to a line, with line breaks in values as `char(10)`. `oc backup` relies on that to reorder rows a line at a time, and refuses an export that is not in that form.
