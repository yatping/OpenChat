# Design system

OpenChat has one look across the dashboard, the website widget, the iPhone app and [openchat.run](https://openchat.run). The colours come from the icon, a blue cube with a navy face. The layouts follow the pattern that customer-messaging products such as Tidio made familiar, so that someone who has used one knows their way around this one.

## The icon

| File | Use |
|---|---|
| [`docs/assets/brand/openchat-mark-512.png`](../assets/brand/openchat-mark-512.png) | The mark on a transparent background, for documents and the README |
| `apps/dashboard/public/brand/` | The mark at 96, 128 and 256 pixels, the favicon, and the home-screen icon |
| The iPhone app's icon and splash | In the private repository with the app. The icon is the mark on a light blue gradient, and the splash background is `#eef3ff` |

The source is a 1254-pixel render. Its edges were cleaned up into a solid mask before any size was made from it. To make new sizes, scale `openchat-mark-512.png` down, never up.

The widget does not show the icon. It sits on a customer's website, which has its own brand.

## Colours

Every pair of text and background in this table meets WCAG AA, 4.5:1, in the theme it belongs to.

| Token | Light | Dark | Use |
|---|---|---|---|
| Primary | `#0a57f5` | `#5b9bff` | Buttons, the agent's own messages, links, selected tabs. White text on the light value is 5.7:1 |
| Primary, pressed | `#0846d1` | | Hover and pressed states |
| Sky | `#18a0fb` | | The light end of the gradient on avatars, from the top of the cube |
| Navy | `#0e1a4f` | | The dashboard's side rail, and the browser's theme colour |
| Background | `#ffffff` | `#0a1233` | Panels, cards, the widget panel |
| Surface | `#f5f7fc` | `#0f1a45` | The page behind cards, and behind a conversation's messages |
| Soft | `#eef4ff` | `#1e2a55` | Selected rows, filter pills, a teammate's messages |
| Line | `#dee4f0` | `#26315f` | Borders and dividers |
| Text | `#0b1437` | `#eef2ff` | Body text |
| Muted text | `#4d5a80` | `#a3aed0` | Times, labels, hints. 6.3:1 on the light surface |
| Danger | `#b42318` | `#fda29b` | Errors, and erasing |
| Online | `#12b76a` | `#32d583` | The dot on an avatar of someone online |

Internal notes stay amber in every surface, so that nobody mistakes one for a reply.

The dashboard replaces Tailwind's `slate` scale with greys tinted toward the navy, and adds a `brand` scale, in [`apps/dashboard/src/styles.css`](../../apps/dashboard/src/styles.css). The widget's values are in [`apps/widget/src/styles.ts`](../../apps/widget/src/styles.ts) and its loader, and the app's in its `src/ui/kit.tsx`, in the private repository. They are copies, not one shared package, because the dashboard is under the AGPL, the widget under Apache-2.0, and the app is not open source. Change all of them together, and this table.

### The widget's colour

A website's own colour, set on the Workspaces page, replaces the primary colour everywhere in its widget. Text on it is black or white, whichever contrasts more. With no colour set, the widget uses the primary blue, `#0a57f5`. A website that saved the old default, `#2563eb`, keeps it.

## Layout

**Dashboard.** A navy rail down the left holds the logo, the workspace's sections, the installation admin's pages, and signing out. Each item is an icon with its name read out and shown on hover. On a phone the rail is a bar along the top. The inbox is one framed surface in three panes: conversations, the open conversation on a tinted background, and the contact and tags.

**Widget.** A round launcher that turns into a close arrow while the panel is open. The panel has a header in the website's colour, with who is online, messages on a tinted background, and a message box with icon buttons to attach and send.

**App.** The same colours, avatars with initials in the conversation list, and rounded message bubbles with a tail on the sender's side.

## Shapes and type

- Corners: 8 pixels on small controls, 12 on cards and fields, 20 on the widget panel. Message bubbles are 18, with 6 on the sender's lower corner.
- Avatars show up to two initials. Someone with no name shows an outline of a person in the dashboard, and a question mark in the app.
- Type is the system font everywhere except openchat.run, which uses Geist.
- Icons are line drawings on a 24-pixel grid, drawn for OpenChat, in [`apps/dashboard/src/icons.tsx`](../../apps/dashboard/src/icons.tsx).
