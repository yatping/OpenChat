# Privacy and data

For whoever answers for personal data at a company running OpenChat. Your company is the controller of what visitors tell you. OpenChat is software you run, not a service that receives your data. This page says what it keeps, where, and for how long, and how to answer a person's request. It is not legal advice.

## Where data is

Everything is in your company's own Cloudflare account: conversations and contacts in a D1 database, files in an R2 bucket. The OpenChat project never receives any of it. Where Cloudflare keeps it depends on the location chosen at deployment; see [Cloudflare's documentation](https://developers.cloudflare.com/d1/configuration/data-location/).

Two things leave your account:

| To | What | When |
|---|---|---|
| Your email provider (Cloudflare Email Sending, or Resend) | A visitor's address and a fixed follow-up text, with no message content. Colleagues' addresses for account emails | Follow-up emails, and new account and password links |
| A notification relay, and Apple | The installation's address and workspace names, an ID for each phone, and encrypted notifications that the relay cannot read | Only if push is set up. The relay forwards each one to Apple for that phone |

The project runs one relay, for the official app. Its privacy policy and terms are drafts awaiting legal review ([drafts](../legal/README.md)). Your company can run its own relay instead.

## What is stored

| About | What |
|---|---|
| Visitors | What they write and send, a name and email address if they give them, whether they allowed follow-up emails, tags your team adds, and an ID for each browser they used. Not their IP address, which is used for rate limits and not stored |
| Colleagues | Name, email, a password hash, roles, and sessions. Their messages and notes, with their name |
| Everyone | An audit log of admin actions, which names colleagues but never visitors |

Logs hold IDs and error codes, never message content, passwords or tokens.

In a visitor's browser, the widget keeps a session in local storage, or only for the tab with `data-consent="pending"`; see [the website widget](widget.md#privacy-on-your-site).

## How long data is kept

By default, until someone deletes it. Each workspace can set **Keep closed conversations**; see [administration](admin.md#retention). Every installation also deletes, by itself:

| What | After |
|---|---|
| Visitors who opened the widget but never wrote | 30 days |
| Expired sign-in sessions and links | Once expired |
| Files uploaded but never sent | 24 hours |
| Failed background jobs | 90 days |

Deleted data stays in the database's Time Travel history for 30 days, and in any backup your operator made; see [backup and restore](../operations/backup-and-restore.md#what-a-restore-does-not-put-back).

## A person's request about their data

An installation admin who is a member of the workspace sees, on the visitor's contact card in the inbox:

- **Export data** downloads everything the workspace holds about them, as JSON: their details, conversations and messages, and the names and sizes of their files. Colleagues are shown only as "a colleague". Internal notes are left out, unless you tick **Export with notes**, because the export usually goes to the person it is about.
- **Erase contact** deletes them, their conversations, messages and files, and their follow-up records, at once. It cannot be undone. If their address is on the list of addresses not to email, it stays there, so that they get no more email. The audit log records that an erasure happened, by ID only.

A person may have written from several browsers, or to several workspaces, each of which is a separate contact. Search each one.

## Follow-up emails

Sent only to visitors who gave an address and ticked the box to allow it, which is never ticked for them. Each email has an unsubscribe link, which works at once and for that workspace. Cloudflare Email Sending also refuses addresses that bounced or complained; OpenChat does not yet receive those reports itself.

## Your privacy notice

Tell visitors, in your website's privacy notice, that the chat is run by your company, what it keeps, for how long, and who to ask about it. If push is used, mention the relay. The [legal drafts](../legal/README.md) for the project's own relay may help, but are not in force.
