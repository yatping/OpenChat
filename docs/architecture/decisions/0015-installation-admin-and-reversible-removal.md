# ADR-0015: Installation admins, and removal that can be undone

**Status:** Accepted by the owner, 2026-11-05. Replaces the in-app account deletion in [ADR-0010](0010-no-global-mobile-account.md) and `POST /api/v1/me/delete`.

## Context

Any signed-in user could delete their own account, which anonymised it and removed them from every workspace. The owner decided that this is the wrong model for a support team:

- Agents should not be able to delete themselves. Their employer manages them.
- History must stay. A former agent's messages should still show who wrote them, for example "Bravo (Removed)".
- Removal should work like Slack, where an account can be reactivated later.
- One admin should manage all agents and assign them to workspaces. Until now, roles existed only per workspace, and joining one needed an emailed invitation.

Removing a member also deleted their row, and messages find their author's name through that row, so a removed member's messages lost their name.

## Decision

**Installation admin.** `users.is_installation_admin` marks people who manage accounts across the installation. The person who sets up the installation is the first. Admins can:

- List everyone and every workspace.
- Create an account, which emails a link lasting seven days to choose a password.
- Assign someone to any workspace with any role, with no invitation, or remove them.
- Deactivate and reactivate accounts, and grant or take away the admin role.
- Create workspaces on an invite-only installation.

**Removing from a workspace.** The member row stays, with `removed_at` set and `status` set to `suspended`. Every access check already refuses a suspended member, including those in a Worker version that does not know about `removed_at`. Open conversations become unassigned and push subscriptions are deleted. Setting the status back to active, or assigning the person again, restores the same member.

**Deactivating an account.** `users.disabled_at` is set, sessions are revoked, and pending tokens are deleted. Memberships stay as they are, so reactivating restores them, along with the password. Conversations become unassigned and push subscriptions are deleted.

**Showing it.** Agent-facing messages carry `sender.removed: true` for both cases, and clients show the name with "(Removed)". Visitors never receive this field, and see the sender as before.

**No self-deletion.** `POST /api/v1/me/delete` is removed, with no replacement in the API.

**Workspace owners and admins keep their own powers** inside their workspace: inviting, suspending, removing, and bringing back. Only an installation admin can deactivate an account, because it reaches into other workspaces.

## Security

- **Admin is not read access.** An installation admin who is not a member gets 404 for a workspace, like anyone else. They can add themselves, so the role is powerful, but that leaves a `person.assigned` audit row in that workspace.
- **Routes are hidden.** Anyone else gets 404 from `/api/v1/admin/*`, including a workspace owner.
- **Decided at commit.** Each change is a batch whose first statement writes the audit row under the conditions that decide it, including that the actor is still an active admin. A request authorised just before the role was taken away changes nothing.
- **Nobody can lock the installation out by accident.** The last active admin cannot give up the role, admins cannot deactivate themselves, and a workspace's only working owner cannot be removed, demoted, or deactivated. A deactivated owner does not count as a working one, and this now also applies to changes made from inside a workspace.
- **Tenancy.** `admin-repository.ts` has no tenant scope by design. It touches accounts and memberships, and never conversations, contacts, or messages. Its context type can only come from checking the role. The isolation harness has a case for every admin route.

## Consequences

- If every admin is lost, an operator who holds Cloudflare access can set the column through `wrangler d1 execute`.
- A deployment with existing data gets its first active owner as admin, through the migration. Check who that is after upgrading an installation with several owners.
- Keeping the name means removal is not erasure. A real erasure request needs an operator tool, which does not exist yet.
- Accounts are never deleted, so a person's address stays taken. Bring them back rather than creating them again.
- Rows with `removed_at` count as members in any new query that does not filter on status. M3 must send notifications only to active members.
- Apple requires in-app deletion from apps that support account creation (guideline 5.1.1(v)). This app has no signup, but whether that exempts it has not been confirmed with Apple. Check before submitting.
