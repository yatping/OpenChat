# Expo configuration and white labelling

The step-by-step guide, from Apple enrolment to push on a phone, is the [self-hosting guide](../operations/self-hosting.md). This document is the design and reference behind it.

## Build-time and runtime configuration

Spec §14 sets out most of this. Amendment A8 moves the relay URL to build time for security.

| Setting | When | Why |
|---|---|---|
| Bundle identifier | **Build** | Identifies the app and is the APNs topic |
| App name, icon, splash | **Build** | Native assets |
| Push environment | **Build**, per profile | Must match the signed entitlement |
| Team ID, signing | **Build** | EAS credentials |
| **Allowed relays** | **Build** | Security: see below |
| Locked installation URL | **Build**, optional | A white-label app could be restricted to one installation. The field exists in a variant, but the app does not use it yet |
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

`app.config.ts` checks the variant before anything else (`variantProblems` in `config/variant.ts`), and a build stops on any problem: an unknown field, a relay that is not a plain `https` origin, push on with no relay, a bad bundle ID or colour, or a missing image. Refusing unknown fields keeps a key or password from being added to the app by mistake.

### Making a variant

```sh
pnpm oc app variant --id acme --name "Acme Support" --bundle-id com.acme.support \
  --relay-env production --color '#0f766e' --icon ./icon.png --splash ./splash.png
```

| Flag | |
|---|---|
| `--id` | The directory name, and `APP_VARIANT`. Lowercase letters, numbers, and hyphens. `official` and `local` are taken |
| `--name` | The name under the icon. Up to 30 characters |
| `--bundle-id` | Your own, registered under your Apple account. It is the APNs topic, and permanent once on the App Store |
| `--relay-env` | Where you ran `oc relay deploy`. Its URL and relay ID become the only relay the app sends a token to. Or give `--relay-url` and `--relay-id`, or `--no-push` |
| `--icon` | PNG, 1024 by 1024, with no transparency, which the App Store refuses. Optional: without it, the variant has the OpenChat icon until you replace `assets/icon.png` |
| `--splash` | PNG. Optional, as for the icon |
| `--color` | The splash background. Default `#2563eb` |

It writes `apps/mobile/variants/<id>/variant.json` and copies the images. It refuses an existing directory, so edit `variant.json` to change one. Relative paths are taken from the repository root, where `pnpm oc` runs. In a fork, commit the variant: nothing in it is secret.

## Building

Builds use `expo prebuild`, then Xcode or fastlane ([ADR-0012](../architecture/decisions/0012-native-builds-without-eas.md)). The `ios/` directory is generated, and is not committed.

```sh
cd apps/mobile
pnpm prebuild
(cd ios && pod install)
pnpm start
```

To build for a registered device, with the JavaScript inside the app so that it runs without Metro:

```sh
cd apps/mobile
cp fastlane/.env.example fastlane/.env    # Fill it in. Git ignores it
fastlane ios refresh_profile              # Registers the bundle ID if missing. Run again after adding a device
fastlane ios device                       # Writes build/ios/OpenLiveChat-adhoc.ipa
fastlane ios install                      # Needs the phone unlocked and connected by cable
```

`refresh_profile` also enables Push Notifications on the App ID, which M3 needs. `APP_VARIANT` chooses a white-label variant, as it does for prebuild. The certificate goes into a temporary keychain that is deleted after each build, and profiles stay in `credentials/`, which Git ignores. With the phone on Wi-Fi only, `install` timed out even though the phone showed as connected. It worked with a cable.

| Build | Command | APNs environment | Distribution |
|---|---|---|---|
| Development | `pnpm prebuild`, then Xcode | **sandbox** | Device, with the development client |
| Ad hoc | `fastlane ios refresh_profile`, then `fastlane ios device` | production | Registered devices |
| App Store | `fastlane ios refresh_profile type:appstore`, then `fastlane ios release` | production | **TestFlight uses production**, as does the App Store |

`fastlane ios release upload:true` also sends the build to TestFlight. That needs the app made once in App Store Connect (Apps, then +), which an API key cannot do. TestFlight refuses a build number it has had before, so with `upload:true` the lane asks App Store Connect for the latest and uses the next, unless `APP_BUILD_NUMBER` is set. Both lanes refuse to build if the app's licences list is out of date; see [the app's notices](../operations/licensing.md#the-apps-notices).

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

Each step can fail without affecting messaging, and it tries again at the next start. On each start the app also asks the installation whether its rows still exist, because a revoked session removes them, and registers again if not. Settings shows why push is off, if it is.

**The official variant allows only the [managed relay](../operations/deployment.md#managed-relay-project-operators).** To test against a temporary relay, make `variants/local/variant.json`, which Git ignores, with `push.enabled` true and that relay in `allowedRelays`, then build with `APP_VARIANT=local`.

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

## Notification Service Extension

Every notification is encrypted for one phone, and an extension on that phone decrypts it ([ADR-0017](../architecture/decisions/0017-encrypted-notifications.md)). With push on, a config plugin adds it at prebuild, so `ios/` is still never edited by hand.

| Part | Where |
|---|---|
| The key for each subscription: made with CryptoKit, private half in the keychain, public half returned to JavaScript | Local Expo module, [`modules/notification-keys`](../../apps/mobile/modules/notification-keys) |
| The extension: decrypts `oc.c` and sets the title and body | [`plugins/notification-service/ios`](../../apps/mobile/plugins/notification-service/ios) |
| The target, its Info.plist and entitlements, the shared keychain group, and the fallback phrases | [`plugins/notification-service/index.ts`](../../apps/mobile/plugins/notification-service/index.ts), applied in `app.config.ts` |

- **Bundle ID.** The extension is `<bundleIdentifier>.NotificationService`, with its own profile for each export method. `fastlane ios refresh_profile` registers it and makes both profiles; `build_ipa` signs it with its own.
- **Keychain.** The app and the extension share `$(AppIdentifierPrefix)<bundleIdentifier>.notifications`. The app lists its own group first, so its session tokens stay in the app's private group and out of the extension's reach. No App Group or portal capability is needed.
- **Fallback.** If the extension fails or runs out of time, iOS shows the phrase for the relay's `loc-key`, from `Localizable.strings` in the app. Only English so far.
- **Checks.** `scripts/check-notification-crypto.sh` compiles the extension's decryption and checks it against RFC 9180 and against a notification sealed by `packages/notification-protocol`. It needs a Mac, because CryptoKit is Apple's, so CI does not run it; run it after changing either side.
- **White label.** A variant with push gets the extension under its own bundle ID. It needs the extension's profiles as well as the app's.

## App Store

| Item | Approach |
|---|---|
| Guideline 2.1 | Demo installation and credentials in the review notes ([Q8](../architecture/open-questions.md)) |
| Guideline 4.2.6 | The official app is a single binary used with many installations, which fits the "picker" model. Customers must submit white-label apps **under their own accounts** |
| Guideline 5.1.1(v) | The app has no signup, and does not offer account deletion ([ADR-0015](../architecture/decisions/0015-installation-admin-and-reversible-removal.md)). Confirm before submitting that this is acceptable |
| Guideline 3.1 | No purchases or purchase prompts in the app |
| Licence | See [ADR-0011](../architecture/decisions/0011-license-boundaries.md) |
| Bundle ID | Decide before first upload, because it is **permanent for the listing** ([Q1](../architecture/open-questions.md)) |

## Independent mode, in brief

1. Enrol in the Apple Developer Program.
2. Create an App ID with Push Notifications.
3. Create an APNs key (`.p8`) and note the Key ID and Team ID.
4. Deploy the relay and set credentials ([deployment](../operations/deployment.md#independent-relay-customers)).
5. Add a variant with `oc app variant`, naming that relay.
6. Build with `APP_VARIANT` set to that variant, using Xcode or fastlane.
7. Distribute through TestFlight and the App Store.

No managed relay credentials are used at any step, and core messaging works before step 4.
