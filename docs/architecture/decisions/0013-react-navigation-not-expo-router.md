# ADR-0013: Use React Navigation in the iOS app, not Expo Router

**Status:** Accepted, 2026-11-05

## Context

The technology baseline named Expo Router. The app's main safety rule is that switching installation or workspace replaces the whole signed-in tree, so that no screen, query cache, or socket survives the switch ([isolation of connections](../../ios-build/expo-and-white-label.md#isolation-of-connections)).

Expo Router gives one app-wide navigation tree, built from files and addressed by URL. The app needs the opposite: a navigation tree that belongs to one connection and workspace, and is thrown away with them. A route URL would also name a screen without naming the installation it belongs to, and installations can have identical IDs.

## Decision

- The app uses `@react-navigation/native`, `@react-navigation/native-stack`, and `@react-navigation/elements`, which are what Expo Router is built on.
- The signed-in tree is one component, keyed by connection ID and workspace ID. It owns its query client, socket, and navigator, and the navigator sits inside `NavigationIndependentTree`.
- The app has no URL routes. A notification tap in M3 resolves its installation and workspace first, as the [iOS build guide](../../ios-build/expo-and-white-label.md#opening-a-notification) describes, and then navigates inside that tree.

## Consequences

- Isolation comes from the component tree, and React remounts everything on a switch without any cleanup code.
- There is no file-based routing or generated route typing. Screen parameters are typed by hand.
- Links from outside the app need explicit code, which is intended: they have to name an installation.
- This replaces Expo Router in the technology baseline.
