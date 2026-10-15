# Privacy policy

_Usage Meter for Claude. Last updated: October 2026._

Usage Meter for Claude is a free, open-source desktop widget, and a Chrome extension, that show your Claude usage limits. It is not affiliated with or endorsed by Anthropic. This policy covers both; where they differ, the extension is called out.

## What the app accesses

- **Your claude.ai sign-in.** You sign in to claude.ai inside the app. The session is stored on your computer, in the app's own browser profile, the same way a web browser stores it. It is used only to ask claude.ai for your usage. The Chrome extension has no sign-in of its own: it uses the claude.ai session already in your browser, and asks for access to claude.ai only.
- **Your usage limits.** The app asks claude.ai for the organizations on your account and their usage: the percentage of each limit used and when it resets. It shows this on your desktop.
- **Your settings.** Refresh interval, appearance, size, widget position and the organization you picked are saved in a settings file on your computer. In the Chrome extension they are saved with `chrome.storage.sync`, so Chrome may sync them to your other computers under your Google account; the usage it last read is stored locally and is never synced.

## What the app does not do

- It does not send your data anywhere except claude.ai. There are no analytics, no telemetry, no advertising and no third-party servers.
- It does not read your conversations, files or anything else on your computer.
- It does not sell, share or transfer any information.

## Where your data is stored

Everything stays on your computer, in the app's data folder (for example `%APPDATA%\Usage Meter for Claude` on Windows). Signing out from Settings > Account deletes the stored claude.ai session. Uninstalling the app removes the app; you can delete the data folder to remove your settings too.

For the Chrome extension, everything stays in your browser profile, except for the settings Chrome syncs as described above. Removing the extension removes its stored data; your claude.ai session belongs to the browser and is unaffected.

## Children

The app is not directed at children and does not knowingly collect information from anyone.

## Changes

If this policy changes, the new version will be published in this file, with an updated date.

## Contact

Questions or concerns: open an issue at https://github.com/ayushvjain/usage-meter-for-claude/issues. To report a security problem privately, use the repository's Security tab > Report a vulnerability.