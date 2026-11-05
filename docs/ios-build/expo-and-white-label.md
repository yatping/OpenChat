# Expo configuration and white labelling

The customer-facing step-by-step guide (Apple enrolment through App Store submission) is written in Milestone 5. This document fixes the design.

## Build-time and runtime configuration

Spec §14 sets out most of this. Amendment A8 moves the relay URL to build time for security.

| Setting | When | Why |
|---|---|---|
| Bundle identifier | **Build** | Identifies the app and is the APNs topic |
| App name, icon, splash | **Build** | Native assets |
| Push environment | **Build**, per profile | Must match the signed entitlement |
| Team ID, signing | **Build** | EAS credentials |
| **Allowed relays** | **Build** | Security: see below |
| Locked installation URL | **Build**, optional | A white-label app can be restricted to one installation |
| Default branding | Build | |
| Installation URLs | **Runtime** | Entered by users, stored per Connection |
| Workspace list | **Runtime** | From the installation |

### Why relay URLs are not runtime configuration

If the app sent its token to whichever relay an installation advertised, a malicious installation could collect tokens from everyone who connected. So the app compares `relay.url` in the discovery document with its build-time allowlist. On a mismatch, it **does not register for push**, and the connection works with an explanation in settings.

Tokens are only useful together with the matching Apple credentials, but they still identify a device, so this control stays.

## Configuration file

`apps/mobile/app.config.ts` reads `variants/<id>/variant.json`, chosen by `APP_VARIANT`, with `official` as the default. Its type is `AppVariant` in `apps/mobile/config/variant.ts`.

**Nothing secret goes in a variant or in `extra`**: they are embedded in the app, and anyone can read them. Check with `pnpm exec expo config --type public`.

A white-label customer adds a directory under `variants/`. The official variant holds only public values, because the APNs key exists only in the relay.

## Building

Builds use `expo prebuild`, then Xcode or fastlane ([ADR-0012](../architecture/decisions/0012-native-builds-without-eas.md)). The `ios/` directory is generated, and is not committed.

```sh
cd apps/mobile
pnpm prebuild
(cd ios && pod install)
pnpm start
```

| Build | APNs environment | Distribution |
|---|---|---|
| Development | **sandbox** | Device, with the development client |
| Ad hoc | production | Registered devices |
| App Store | production | **TestFlight uses production**, as does the App Store |

Set `APP_PROFILE` to anything other than `development` for a release build. Getting this wrong produces `BadDeviceToken` from APNs, and the relay's metric on that reason exists to catch it. The app reports the environment explicitly, because the build sets the entitlement.

A customer can also use EAS to build a variant, but nothing in the app needs it.

The round gear labelled "Tools" that floats over the top right corner of a development build comes from the development client. It is not part of the app, and it does not appear in a release build.

## Push registration in the app

```text
On connect, sign-in, or app start (only if enabled and the relay is allowlisted):
  1. requestPermissionsAsync
  2. getDevicePushTokenAsync         -> native APNs token (not an Expo token)
  3. POST <installation>/push/grants
  4. POST <relay>/v1/devices/register
  5. POST <installation>/push/subscriptions

addPushTokenListener(token => POST <relay>/v1/devices/token)     // updates all connections at once

On logout:
  POST <relay>/v1/devices/unregister (device secret), then DELETE the installation subscription and wipe local data.
  If offline, queue the relay call. The installation also revokes server-side on session revocation.
```

Expo's push service isn't used, in keeping with the spec's native APNs approach. It would add a third party with its own token.

## Isolation of connections

Acceptance: "switching workspaces never leaks conversation data". This relies on structure, not on remembering to filter.

```text
ConnectionManager
  └── Connection (installationId + userId), one on a device (ADR-0014), keyed by a local connection ID
        ├── Tokens           expo-secure-store, key prefix conn.<id>.
        ├── ApiClient        bound to one base URL and token source. There is no global client.
        ├── QueryClient      one per Connection and workspace. Never shared.
        ├── Local files      a cache directory per Connection, deleted on logout
        └── Socket           open only for the active Connection in the foreground
```

- Switching workspace or signing in to another installation replaces the top-level provider with a new `key`, unmounting the screens, query client, socket, and navigator together, so no state survives ([ADR-0013](../architecture/decisions/0013-react-navigation-not-expo-router.md)).
- Deep links name their target explicitly, and never use "current workspace".
- Signing in to another installation replaces the Connection and wipes what it held. A test does this with two fake installations with **identical IDs**.
- A Connection is known by a local ID, because installations choose their own IDs and can collide.
- The connection record is not secret and lives in app storage. Message data is held in memory, so there is no offline cache yet.
- A simulator build must be signed, even ad hoc (`CODE_SIGN_IDENTITY=-`). Without a signature the keychain refuses every write, and sign-in fails.

## Files

Files move as bytes through `expo/fetch`, because React Native's own `fetch` handles binary data poorly. They still go through the same API client, so an expired token is refreshed and the request retried.

- **Downloads** go to `Paths.cache/connections/<connection ID>/attachments/<attachment ID>/<name>`, so signing out removes them. The name and ID come from the installation, so each is reduced to one safe path segment. A download that finishes after sign-out deletes what it wrote.
- **Previews** show PNG, JPEG, GIF, and WebP files up to 5 MB. Never SVG. Other files open in the system share sheet, which is also the only way a file leaves the app, and only when the person chooses.
- **Photos are encoded again when picked, to remove metadata.** The iOS picker hands over location data by default, and a visitor can download what an agent sends. On a test photo, the original upload kept its GPS directory, and the re-encoded one lost it along with the camera model. Do not remove `quality` from `pickPhoto` without repeating that check. The tag that keeps a photo the right way up stays.
- **Documents are sent unchanged.** The app cannot remove metadata from a PDF or an Office file, so what is inside one is the sender's choice.
- **Picked copies** live outside the connection's folder, so they are deleted after each upload, whether it worked or not. iOS gives the app its own copy of a document, never the original, and `isPrivateCopy` refuses to delete anything outside the app's `tmp` and `Caches` folders.

## Opening a notification

```text
Tap -> read oc.installationId, oc.workspaceId, oc.conversationId from the payload
  -> compare oc.installationId with the Connection's
      different or none: stale subscription. Show a message and unregister.
  -> session expired: sign in, retaining the destination
  -> switch workspace
  -> fetch the conversation from the installation
      404 problem response (access removed): show a message and return to the inbox
      any other 404 (the platform's HTML page): retry, since access may be fine
  -> navigate
```

Use `getLastNotificationResponse()` at launch and `addNotificationResponseReceivedListener` afterwards, then clear the response so that it does not navigate twice. From SDK 58, notifications show in the foreground by default, so a handler suppresses those for the conversation on screen.

## Notification Service Extension (not in the MVP)

An extension could replace "New message" with real text by fetching on the device. Expo has no built-in support: it needs a config plugin, native code, an app group, shared keychain access to tokens, and declaring the target under `extra.eas.build.experimental.ios.appExtensions`. It also complicates white-label signing. Defer it ([Q7](../architecture/open-questions.md)). The payload already sets `mutable-content`, so it can be added without any protocol change.

## App Store

| Item | Approach |
|---|---|
| Guideline 2.1 | Demo installation and credentials in the review notes ([Q8](../architecture/open-questions.md)) |
| Guideline 4.2.6 | The official app is a single binary used with many installations, which fits the "picker" model. Customers must submit white-label apps **under their own accounts** |
| Guideline 5.1.1(v) | The app has no signup; in-app deletion of the account on an installation is offered regardless |
| Guideline 3.1 | No purchases or purchase prompts in the app |
| Licence | See [ADR-0011](../architecture/decisions/0011-license-boundaries.md) |
| Bundle ID | Decide before first upload, because it is **permanent for the listing** ([Q1](../architecture/open-questions.md)) |

## Independent mode, in brief

1. Enrol in the Apple Developer Program.
2. Create an App ID with Push Notifications.
3. Create an APNs key (`.p8`) and note the Key ID and Team ID.
4. Add a variant with that bundle ID and the customer's relay URL.
5. Deploy the relay and set credentials ([deployment](../operations/deployment.md#independent-relay-customers)).
6. Build with `APP_VARIANT` set to that variant, using Xcode or fastlane.
7. Distribute through TestFlight and the App Store.

No managed relay credentials are used at any step, and core messaging works before step 5.
