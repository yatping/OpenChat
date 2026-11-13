# Licensing

How OpenChat's licences are kept: what each component is under, what CI checks, the notices that ship with the bundles, and the source offer the AGPL asks of an installation. The reasons for the split are in [ADR-0011](../architecture/decisions/0011-license-boundaries.md).

This is not legal advice. The open points at the end are for the owner's legal review.

## Components

| Licence | Components |
|---|---|
| AGPL-3.0-or-later | The API Worker, the notification relay, the dashboard, the server packages (`core`, `realtime`, `email`, `database`, `auth`, `ui`) and the tooling, including the CLI |
| Apache-2.0 | The widget, the mobile app, `api-client`, `api-contracts`, `notification-protocol` and `shared` |

Each package says which in its `package.json`. The full texts are in [`LICENSES/`](../../LICENSES), and [`LICENSE`](../../LICENSE) explains the split.

## Contributions: the DCO

OpenChat uses the [Developer Certificate of Origin](https://developercertificate.org/), not a contributor licence agreement. ADR-0011 explains why: a DCO asks less of contributors, but without a CLA the AGPL components cannot later be relicensed without every contributor's consent.

Each commit carries a `Signed-off-by` line whose address matches the commit's author. The `dco` job in [`ci.yml`](../../.github/workflows/ci.yml) runs [`check-dco.mjs`](../../tooling/scripts/check-dco.mjs) on every pull request, and is a required check on `main`. Dependabot cannot sign off, so its pull requests are exempt; they change only dependency versions. [CONTRIBUTING.md](../../CONTRIBUTING.md#developer-certificate-of-origin) tells contributors how to sign off.

## What CI checks

`pnpm check:licenses`, part of `pnpm verify`, runs after the build. It checks three things:

1. **Each workspace package has its licence.** The licence named in the table above, and the licence texts are present.
2. **No permissive package depends on an AGPL one.** This covers dependencies reached through another workspace package, and `devDependencies`, because a bundle can include them. Shared build configuration (`tsconfig`, `eslint-config`) is exempt, since it ships in nothing.
3. **What each component ships from third parties is allowed by its licence**:

| Component | What is checked | Its licence allows |
|---|---|---|
| Widget | The packages in its two bundles, as Vite's `build.license` lists them | Permissive licences |
| Dashboard | The packages in its bundle, the same way | Permissive, and copyleft that AGPL code can include |
| API Worker, relay | The packages esbuild bundled, from the metafile `wrangler deploy --dry-run --metafile` writes | The same as the dashboard |
| Mobile app | Its production dependencies, as `pnpm licenses list --prod` gives them. This includes Expo's build tools, so it is more than ships | Permissive licences |

Permissive means MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Zlib, Python-2.0 and CC-BY-4.0. The copyleft an AGPL component may include is MPL-2.0, LGPL, GPL-3.0 and AGPL-3.0. GPL-2.0-only is not included, because it cannot be combined with AGPL-3.0. In an expression such as `(BSD-3-Clause OR GPL-2.0)`, one allowed choice is enough. In `A AND B`, both must be allowed. A package that states no licence fails.

An exception needs a reason a reviewer can check, in [`licenses.mjs`](../../tooling/scripts/licenses.mjs). There is one:

| Package | Licence | Why it is allowed |
|---|---|---|
| `lightningcss` | MPL-2.0 | A CSS compiler that Expo uses at build time. It does not ship in the app |

The policy has its own tests, in `licenses.test.mjs`, which run first.

## Notices

MIT, BSD and Apache-2.0 ask that their notices go with copies of the code. The dashboard and widget bundles are copies, sent to every browser that loads them, so each build publishes its notices:

| Bundle | Notices |
|---|---|
| Dashboard | `/third-party-licenses.txt`, linked from the footer of every dashboard page |
| Widget | `/widget/third-party-licenses.txt` |

[`collect-assets.mjs`](../../services/api/scripts/collect-assets.mjs) writes them from Vite's licence output, which itself is not served. Vite lists JavaScript packages only. Tailwind, the one package that adds to the dashboard's CSS, keeps its own notice at the top of the stylesheet.

The Workers' code is not distributed: it runs on Cloudflare for the operator. Its notices go with the source, through each package's own `node_modules` copy.

**The mobile app has no notices screen yet.** An App Store build distributes its bundled packages, so it needs one before submission. This is part of the App Store submission work in [Milestone 6](../plan/milestones.md#m6-hardening-and-release-m).

## The source offer

The AGPL's section 13 asks that a modified server offer its source to everyone who uses it over a network. OpenChat makes that offer for every installation:

- The discovery document, `/.well-known/openchat.json`, has a `software` field, with `version`, `license` and `source`. See [API conventions](../api/conventions.md#discovery-and-compatibility).
- The dashboard's footer, on the sign-in page and every page after it, shows the version and links to that source and to the notices.

By default, `source` is the project's repository at the deployed release, such as `https://github.com/yatping/OpenChat/tree/v0.3.0`. That is the right source only for an unchanged release. `oc deploy` passes the release version to the Worker as `OPENCHAT_VERSION`. A Worker deployed some other way publishes no version, and links to the repository.

**If you change the code,** publish your version somewhere your users can reach, and point the offer at it:

```bash
pnpm oc deploy --env production --source-url https://git.example.com/our-openchat
```

The setting is remembered for later deploys. `--source-url none` goes back to the project's source. `oc deploy` and `oc upgrade` print a reminder when the checkout is not the release tag, or has changes to tracked files, and no source URL is set. Only you know whether your changes need publishing, so this is a reminder, not a stop.

The relay is AGPL too, but has no users who browse it: installations call it. The managed relay runs an unchanged release. Someone who runs a changed relay should publish its source where the installations using it can find it.

**Security.** The discovery document now tells anyone which release an installation runs, which helps an attacker choose a known vulnerability. The source offer needs the version to be honest, and installations upgrade on their own schedule, so the version is published. [SECURITY.md](../../SECURITY.md) asks operators to upgrade when a release carries a security fix.

## For the owner's legal review

- **Visitors.** People chatting through the widget also use the AGPL server over a network. The offer is in the dashboard and the discovery document, not in the widget, because a link inside a customer's website is a product decision. Decide whether that is enough.
- **The app and the App Store.** The app is Apache-2.0 so that it can be on the App Store (ADR-0011). Its notices screen is still to come, as above.
- **The DCO without a CLA.** Accepted in ADR-0011, with its consequence: no relicensing without every contributor's consent.

## Limits

- Only npm packages are checked. CocoaPods and native code that Expo adds at prebuild are not, nor is Xcode's own toolchain.
- The app's check is wider than what ships, so it can fail on a build tool. That is why the one exception exists.
- Licence fields are taken as each package states them. A package that misstates its licence is not caught.
