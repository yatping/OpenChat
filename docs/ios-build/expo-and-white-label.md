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

```typescript
// apps/mobile/app.config.ts
import type { ExpoConfig } from 'expo/config';
import { loadVariant } from './config/load-variant';

const variant = loadVariant(process.env.APP_VARIANT ?? 'official');
const profile = process.env.EAS_BUILD_PROFILE ?? 'development';

export default (): ExpoConfig => ({
  name: variant.appName,
  slug: variant.slug,
  scheme: variant.urlScheme,
  icon: variant.assets.icon,
  splash: { image: variant.assets.splash, backgroundColor: variant.branding.primaryColor },
  ios: {
    bundleIdentifier: variant.bundleIdentifier,
    supportsTablet: true,
    infoPlist: { UIBackgroundModes: [] },
  },
  plugins: [['expo-notifications', { enableRemoteNotifications: variant.push.enabled }], 'expo-secure-store'],
  extra: {
    variant: variant.id,
    push: {
      enabled: variant.push.enabled,
      environment: profile === 'development' ? 'sandbox' : 'production',
      allowedRelays: variant.push.allowedRelays,
    },
    lockedInstallationUrl: variant.lockedInstallationUrl ?? null,
    branding: variant.branding,
  },
});
```

**Nothing secret goes in `extra`**: it is embedded in the app and is readable by anyone. Check with `npx expo config --type public`.

## Variant definition

```typescript
// apps/mobile/config/variant.ts. Replaces the spec's AppConfiguration.
export interface AppVariant {
  id: string;
  appName: string;
  slug: string;
  urlScheme: string;
  bundleIdentifier: string;
  lockedInstallationUrl?: string;
  push: {
    enabled: boolean;
    allowedRelays: { id: string; url: string }[];
  };
  branding: { primaryColor: string };
  assets: { icon: string; splash: string };
}
```

Variants live in `apps/mobile/variants/<id>/`. A customer adds a directory. The official variant holds only public values: there is no key material in it, since the APNs key exists only in the relay.

## Build profiles

```jsonc
// apps/mobile/eas.json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal", "env": { "APP_VARIANT": "official" } },
    "preview":     { "distribution": "internal", "env": { "APP_VARIANT": "official" } },
    "production":  { "autoIncrement": true, "env": { "APP_VARIANT": "official" } },
    "custom":      { "extends": "production", "env": { "APP_VARIANT": "custom" } }
  }
}
```

The `cli.version` floor is set in P0 from the version then current.

| Profile | APNs environment | Distribution |
|---|---|---|
| `development` | **sandbox** | Device, dev client |
| `preview` | production | Ad hoc |
| `production`, `custom` | production | **TestFlight uses production**, as does the App Store |

Getting this wrong produces `BadDeviceToken` from APNs. The relay's metric on that reason exists to catch it. The app reports the environment explicitly, because the entitlement is set by the build, with the plugin writing development and release archives switching to production.

Customers can also build without EAS, using `npx expo prebuild` and Xcode, as spec §13.2 requires.

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
  └── Connection (installationId + userId), keyed by a local connection ID
        ├── Tokens           expo-secure-store, key prefix conn:<id>:
        ├── ApiClient        bound to one base URL and token source. There is no global client.
        ├── QueryClient      one per Connection. Never shared.
        ├── Local cache      a SQLite file per Connection, deleted on logout
        └── Socket           open only for the active Connection in the foreground
```

- Switching replaces the top-level provider with a new `key`, unmounting the whole screen tree so no component state survives.
- A workspace is a selection inside a Connection, included in every query key.
- Deep links name their target explicitly, and never use "current workspace".
- A test mounts two fake installations with **identical IDs** and asserts that nothing crosses between them.

## Opening a notification

```text
Tap -> read oc.installationId, oc.workspaceId, oc.conversationId from the payload
  -> find Connection by installationId
      none: stale subscription. Show a message and unregister.
  -> session expired: sign in, retaining the destination
  -> switch Connection and workspace
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
6. `eas build --profile custom`, or use Xcode.
7. Distribute through TestFlight and the App Store.

No managed relay credentials are used at any step, and core messaging works before step 5.
