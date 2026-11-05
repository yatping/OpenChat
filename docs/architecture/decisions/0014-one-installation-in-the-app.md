# ADR-0014: The app connects to one installation at a time

**Status:** Accepted by the owner, 2026-11-05. Amends the spec's requirement for an app connected to several installations (§1, §3.1, §17, §20), and the milestone exit check that followed from it.

## Context

The brief has one app connected to several independent installations at once. An app built that way needs an installation switcher, and has to keep several sessions and sets of push subscriptions alive on one device.

The owner decided that agents do not need this. What they do need is switching between the workspaces they belong to, on one installation.

## Decision

- The device holds one Connection. There is no "Add an installation" and no switcher.
- Signing out returns to the screen that asks for an address. Signing in to another installation replaces the Connection and wipes everything held for the old one.
- Settings switches between the user's workspaces on that installation.
- The official app remains a single binary. Different customers still point it at their own installations.

## Consequences

- Someone who works on two separate installations must sign out to move between them, and gets push notifications only from the one they are signed in to.
- Everything a connection owns stays keyed by a local connection ID, and the signed-in tree stays keyed by connection and workspace ([ADR-0013](0013-react-navigation-not-expo-router.md)). That costs nothing, it is what keeps workspaces apart, and it leaves the door open if this decision is ever reversed.
- The relay still serves many installations, because different devices belong to different ones. A single APNs token will now normally serve one installation.

## What was tested before this decision

Two local Workers reporting identical IDs, on one simulator: neither showed the other's data, a live message to one did not appear in the other, switching worked both ways, and signing out of one left the other signed in. That code is gone. The unit test with identical IDs now checks that signing in to the second wipes the first.
