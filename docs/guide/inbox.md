# The inbox

For agents and supervisors. The inbox is the same on the web dashboard and in the iPhone app, though the app has fewer settings.

## Signing in

Open your installation's address, such as `https://chat.company.com`, and sign in with your email address and password. Your first password comes from the link your administrator's account email sent you. It lasts seven days. If it has run out, ask for a new one.

Forgot your password? Choose **Forgot your password?** and enter your address. If the account exists, a link arrives by email. Using it signs you out everywhere else.

## Finding conversations

The list on the left shows one status at a time, newest activity first. Choose the status, and whose conversations, at the top of the list:

| Status | Means |
|---|---|
| open | Waiting for the team. New conversations start here |
| pending | Waiting for the visitor, or for something outside the chat |
| resolved | Finished |
| archived | Put away |

A message from the visitor puts a conversation back to **open**, whatever its status, so that someone sees it.

**Assigned to** filters by **Everyone**, **Me** or **Unassigned**. High and urgent conversations are marked in the list.

New messages appear as they arrive. If live updates are blocked, for example by a company network, the dashboard says so and checks every 30 seconds instead. Sending still works.

If you belong to more than one workspace, choose it at the top of the page. Each workspace's conversations stay in that workspace.

## Answering

Open a conversation to see its messages, and the visitor's contact card beside them.

- **Reply** goes to the visitor. **Enter** sends, and **Shift+Enter** starts a new line.
- **Internal note** is seen only by your team. It never reaches the visitor, in the widget or in an email.
- **Attach a file** to send up to 25 MB: images (PNG, JPEG, GIF, WebP), PDF, ZIP, Word, Excel, PowerPoint, plain text or CSV. Other types, including HTML and SVG, are refused.

At the top of the conversation you can change its **status**, its **priority** (low, normal, high or urgent) and who it is **assigned** to. An agent can assign conversations to themselves, and reassign only their own. A supervisor can assign anyone's.

If someone else changes a conversation at the same moment as you, your change is refused with "This conversation just changed". Check what changed, and try again.

Whether the visitor is online now is shown on the conversation. The visitor sees when the team is typing a reply, never a note.

## Contacts and tags

The contact card shows what the visitor told you: a name, and an email address if the website asked for one. **The address is not verified.** Anyone can type any address, so do not share account details because of it. You can correct the name and address and **Save contact**.

Tags help find and group conversations. Type a tag to add it to the conversation, or choose one the workspace already uses.

An installation admin who is a member of the workspace also sees **Export data** and **Erase contact** on the card. See [privacy and data](privacy.md#a-persons-request-about-their-data).

## On iPhone

The official OpenChat iPhone app does the same work: the inbox, replies and notes, files and photos, status and assignment, the contact card and tags.

**The official app is not on the App Store yet.** Until it is, your team uses the dashboard. A company that builds its own branded app distributes it itself.

1. Open the app, and under **Connect to your team** enter your installation's address. Your administrator can give it to you. It must be `https://`.
2. Sign in with the same email and password as the dashboard.

Photos have their location and other details removed before they are sent. Documents are sent as they are.

**About and licences**, under Settings, shows the app's version, the open-source licences it includes, and where to get the source of the app and of your installation.

**Notifications.** Under **Settings**, choose which to receive: **New conversations**, **New messages**, or only those **Assigned to you**, for each workspace. They need your installation to be connected to a notification relay, and iOS to allow notifications for the app. Notifications are end-to-end encrypted to your phone: the relay that carries them cannot read them. If push is not available, the app says why, and messages still arrive while it is open.

Signing out of the app removes that installation's data from the phone.
