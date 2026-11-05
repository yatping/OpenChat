# ADR-0016: The installation admin replaces workspace owners and admins

**Status:** Accepted by the owner, 2026-11-05. Supersedes these parts of [ADR-0015](0015-installation-admin-and-reversible-removal.md): workspace owners and admins keeping their own powers, the rule that a workspace keeps an owner, and creating a workspace from inside one. Changes the brief's "multi-tenant support within each installation" (§1): the isolation stays, and the administration does not.

## Context

ADR-0015 added an installation admin alongside the workspace roles owner, admin, supervisor, and agent. That left two groups managing the same people, with rules about which could do what, including that every workspace must keep an owner.

The owner decided that each company runs its own installation, so nobody needs to delegate administration between unrelated tenants inside one.

## Decision

**Each company has its own installation.** A workspace is a team or brand within one company. Its data stays isolated from other workspaces exactly as before, and the tenancy rules do not change. What goes is the idea of a tenant who administers itself.

**Two workspace roles remain.**

| | Supervisor | Agent |
|---|---|---|
| View and reply to conversations, add notes, assign to self | Yes | Yes |
| Assign to others, and transfer | Yes | Own only |
| Merge contacts, and delete tags | Yes | No |

**Everything else belongs to the installation admin:** people and the admin role, creating and renaming workspaces, and websites and their widget settings. Automation and email settings will go here when they are built. Admin routes are under `/api/v1/admin`.

**Managing does not include reading.** An admin changes settings without joining a workspace, but gets 404 on its conversations, contacts, messages, and members until they add themselves. Adding themselves writes a `person.assigned` audit row. Creating a workspace does not join it. The first admin is a supervisor of the first workspace, so that a new installation works straight away. Exporting or deleting a contact, when built, will need an admin who has joined, because it reads contact data.

**No invitations.** Accounts and memberships are made on the People page. Bringing someone back from `suspended`, a status that nothing sets any more, is also done by assigning them. A workspace may have nobody in it.

**No signup.** Nobody can create an account or a workspace for themselves. The `signup_policy` column is no longer read, and discovery always reports `invite_only`.

## Migration

Migration `0004` makes every owner and admin a supervisor, and deletes pending invitations. A deployment's existing installation admins stay admins.

The CHECK constraint still allows `owner` and `admin`, and the `invitations` table stays, because a Worker from before the migration can still use them until the new one is live. Reads treat a stored `owner` or `admin` as a supervisor, so anything written in that window keeps working. The consumer acknowledges and drops `workspace.invitation_email` jobs left in the queue. A later migration can remove all of these once no earlier Worker can run.

## Security

- **Every admin has power over every workspace.** Making someone an admin is the same as giving them the whole installation. An admin who wants to read a workspace can, but it leaves a record in that workspace's audit log. The log is evidence, not prevention.
- **Decided at commit.** Workspace and website changes follow the batch pattern from ADR-0015: the audit row is written first, under a check that the actor is still an active admin. These changes were not audited before.
- **The repository stays narrow.** `admin-repository.ts` has no tenant scope by design, and still never touches conversations, contacts, or messages. A website is matched on its workspace as well as its ID, so one named under the wrong workspace is not found.
- **Tested for each route.** The isolation harness asserts that a non-member admin gets 404 and changes nothing on every workspace route, and that a supervisor gets 404 on every admin route.

## Consequences

- One installation cannot safely host unrelated companies, because nobody can be an admin of only part of it. Hosting several would need this decision reversed.
- A team lead cannot add or remove their own agents. Every staffing change goes through an admin, or that lead becomes an admin of everything.
- Any former owner or admin who was not the installation admin loses settings access on upgrade, and an installation admin must grant it back if needed. Check who holds the role after upgrading.
- Losing the last admin now also blocks website and workspace changes. The recovery in ADR-0015, setting the column through `wrangler d1 execute`, still applies.
