# App Store submission: the official app

What is ready for submitting the official OpenChat app (`com.orangolabs.openchat`, App Store Connect app 6833420293), what to enter in App Store Connect, and what only the owner can decide. Builds and signing are in [Expo and white label](expo-and-white-label.md). Apple's own rules are in the [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Status

| Item | State |
|---|---|
| App Store profiles for the app and its notification extension | Made, valid until 2027-06-11 |
| Builds in TestFlight | Build 2, version 0.1.0, named OpenChat, uploaded 2026-11-13. Build 1 carried a name the owner then reverted, so do not submit it |
| Open-source notices in the app | Settings, **About and licences**. See [licensing](../operations/licensing.md#the-apps-notices) |
| Demo installation for App Review | Running. See [below](#demo-installation) |
| App Store listing text | Drafted below |
| Privacy policy URL | **Blocked**: the [draft](../legal/privacy-policy.md) covers the app, but is not in force until legal review ([Q5](../architecture/open-questions.md)) |
| App Privacy answers | Drafted below. **The owner confirms them** |
| Export compliance | Drafted below. **The owner confirms it** |
| Screenshots | **Not made.** Take them on a device against the demo installation |
| Guideline 5.1.1(v), account deletion | Explained in the review notes below. **The owner confirms** that this is acceptable |
| Submit for review | **The owner's step**, in App Store Connect |

## Listing

| Field | Draft |
|---|---|
| Name | The App Store Connect record is named "OpenChat: Your Chat Your Cloud". The app's name on the home screen stays OpenChat. Several other projects use this name, and no trademark search has been done ([Q1](../architecture/open-questions.md)) |
| Subtitle | Team inbox for website chat |
| Category | Business. Secondary: Productivity |
| Price | Free. No in-app purchases |
| Age rating | 4+. The app shows messages from a company's own customers, and has no web browsing, gambling or user-generated public content |
| Support URL | `https://github.com/yatping/OpenChat/issues` |
| Marketing URL | `https://github.com/yatping/OpenChat` |
| Privacy policy URL | The published privacy policy, once it is in force |
| Copyright | Orango Labs Ltd |

**Description:**

> OpenChat is the iPhone app for teams that answer customer chat with OpenChat, the open-source chat platform that each company runs in its own Cloudflare account.
>
> Connect to your company's OpenChat by its address, sign in with the account your administrator gave you, and answer customers from anywhere:
>
> • See new conversations from your website as they arrive
> • Reply, or write internal notes that only your team can see
> • Send photos and documents. Photo location is removed before sending
> • Assign conversations, set their status and priority, and tag them
> • Get notifications, end-to-end encrypted to your phone, so that the service delivering them cannot read them
>
> OpenChat needs an OpenChat installation run by your company. There is no sign-up in the app: your administrator creates your account. To run your own, see github.com/yatping/OpenChat.

**Keywords:** `live chat,customer support,helpdesk,inbox,website chat,team inbox,support,open source,self-hosted`

**What's new:** First release.

## Demo installation

Apple's reviewers need a working backend and an account (guideline 2.1). One runs for them:

| | |
|---|---|
| Address | `https://oc-openchat-demo.yatping0617.workers.dev` |
| Deployment | `pnpm oc deploy --env openchat-demo`, on the owner's Cloudflare account, connected to the managed relay |
| Reviewer account | `app-review@example.com`, a supervisor of the workspace Demo Store. The password is in `.openchat/openchat-demo/review-password` on the deploying computer, readable only by its owner. **Enter it only in App Store Connect's sign-in fields, never in a file in Git** |
| Data | A website, Demo Store, and three conversations from made-up visitors: one open, one pending and one resolved, with replies, an internal note and tags |
| Visitor side | The website key is in `.openchat/openchat-demo/demo-site.txt`. To show a reviewer a live message, open a page with the widget on an allowed origin, or send one with the widget API |

It is not reset automatically. Before each submission, check that the reviewer can sign in, and that nothing personal has been added. A nightly reset, as [Q8](../architecture/open-questions.md) suggests, is not built.

The account has no email address that receives mail, so password reset does not reach it. Change its password with `pnpm oc recover --env openchat-demo --email app-review@example.com`, which prints a reset link, then update App Store Connect.

## Review notes

Paste into **App Review Information**, with the demo account's email and password in the sign-in fields:

> OpenChat is a team inbox for website chat. Each company runs its own OpenChat installation, and its staff use this app to answer customers.
>
> To review: open the app, enter the address oc-openchat-demo.yatping0617.workers.dev, and sign in with the demo account above. You will see the Demo Store workspace with sample conversations. Open one to reply, write an internal note, attach a photo, change its status or assignment, or open Contact and tags. Settings shows notification choices, and About and licences.
>
> Accounts are created by each company's administrator, not in the app, and the app offers no sign-up. Deactivating or removing an account is done by that administrator, who controls the company's data (guideline 5.1.1(v)).
>
> Notifications are end-to-end encrypted: the company's installation encrypts each one for the phone, a relay passes it to Apple, and the app's notification service extension decrypts it on the device.

## App Privacy

What Apple asks is whether **the developer**, Orango Labs Ltd, or its partners collect data from the app. Messages, accounts and contacts go only to the company's own installation, which Orango Labs neither runs nor can read. Only push delivery reaches Orango Labs, through the managed relay. Suggested answers, for the owner to confirm with the reviewed privacy policy:

| Data type | Collected | Use | Linked to the user | Tracking |
|---|---|---|---|---|
| Identifiers: Device ID (the push token, and the relay's ID for the phone) | Yes, if notifications are allowed | App Functionality | No: the relay holds no name, email or account | No |
| Everything else, including contact info, user content and diagnostics | No. It goes to the company's installation, not to the developer | | | |

There is no analytics, advertising or crash reporting SDK in the app.

## Export compliance

The app uses HTTPS, and Apple's CryptoKit for decrypting notifications with HPKE (RFC 9180). Both are standard encryption from the operating system, which Apple's questionnaire treats as exempt. Suggested answer: it uses encryption, and only exempt, standard encryption. Once confirmed, setting `ITSAppUsesNonExemptEncryption` to `false` in `app.config.ts` saves answering for each build.

## Before pressing Submit

1. The privacy policy is reviewed, published, and its URL entered.
2. App Privacy and export compliance answers confirmed and entered.
3. The build to submit chosen: build 2, or a newer one from `fastlane ios release upload:true`. The version shown on the App Store is 0.1.0, from `app.config.ts`; change it there first if the first release should be 1.0.
4. Screenshots for the sizes App Store Connect asks for, from the demo installation.
5. The demo account signs in, on a phone, with the app built for review.
6. The managed relay's [terms](../legal/relay-terms.md) are in force, since reviewers' phones register with it.
