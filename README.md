# Usage Meter for Claude

A small Windows desktop widget that shows how much of your Claude plan you have used, when each limit resets, and whether Claude's peak hours are on right now.

<a href="https://apps.microsoft.com/detail/9PKK2BWSPQG6?mode=direct"><img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="Get it from Microsoft" /></a>

It shows usage for paid plans: Pro, Max, Team and Enterprise. The widget shows whichever limits claude.ai reports for your account: the 5-hour session, the weekly limit, and any per-model weekly limits. claude.ai doesn't currently report usage figures for Free accounts, so on the Free plan there are no bars to show; the widget still shows peak hours.

<p>
  <img src="docs/screenshot-dark.png" width="320" alt="Widget in dark mode" />
  <img src="docs/screenshot-light.png" width="320" alt="Widget in light mode" />
</p>

If this saves you a few trips to Settings → Usage, a ⭐ on the repo would mean a lot. It helps other people find it.

> Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.

## What it shows

- **Current session** (the 5-hour window): percent used and time until it resets.
- **Weekly limits**: every weekly bar your account has, each with its reset day and countdown.
- **Peak hours**: whether peak hours are on, and a countdown to the next change, in your local time. The schedule is Monday to Friday, 13:00 to 19:00 UTC, as published on [claude-peak-time.pages.dev](https://claude-peak-time.pages.dev/). You can turn this off in Settings if it doesn't apply to your plan.

Bars turn amber and then red as you get close to a limit. Your claude.ai chats, the Claude desktop app and Claude Code all draw from the same limits, so these numbers cover all of them.

## Install

**Recommended:** get it from the [Microsoft Store](https://apps.microsoft.com/detail/9PKK2BWSPQG6?mode=direct). It installs in one click, updates automatically, and doesn't show any security warnings.

<a href="https://apps.microsoft.com/detail/9PKK2BWSPQG6?mode=direct"><img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="Get it from Microsoft" /></a>

**Or** download the installer from [Releases](../../releases). Windows may show **"Windows protected your PC"**, because the installer isn't signed; click **More info**, then **Run anyway**.

Works on Windows 10 and 11. A macOS version is in progress.

## Getting started

1. Open the app and click **Sign in**. claude.ai opens in its own window; sign in as usual, and the window closes on its own once you're in.
2. If your account belongs to more than one organization (for example a personal plan and a work or university seat), pick the one to show. The widget remembers your choice.
3. That's it. The widget refreshes on its own every 5 minutes.

### Where the widget lives

The widget sits on your desktop, like a large desktop icon: above the wallpaper, and behind every app window. Open windows cover it, and pressing **Win+D** (Show desktop) brings it into view. It doesn't appear in the taskbar or in Alt+Tab.

- **Move it:** drag it by its title. When you let go, it snaps to your desktop icon grid, or flush into a screen corner. It remembers where you put it.
- **Resize it:** drag its bottom-right corner to make the whole widget bigger or smaller, for example on a large monitor. Double-click the corner to go back to 100%.
- **Menu:** click the `⋯` button on the widget, or right-click the tray icon, for **Refresh now**, **Settings**, **Hide widget** and **Quit**. Clicking the tray icon hides or shows the widget.

The widget sizes itself to your account: it's exactly as tall as its content and just as wide, so it's a square with even spacing on every plan. Accounts with more limits get a bigger square.

### Refreshing

- The widget refreshes every 5 minutes by default. You can change this in Settings (1 to 30 minutes).
- Click the refresh button to refresh straight away. The countdown to the next automatic refresh then starts again.
- The footer shows when the data was last updated and when the next refresh is due.

## Settings

Open **Settings** from the `⋯` menu or the tray icon:

- **General:** how often to refresh, whether to show peak hours, and whether to start with Windows. (In the Microsoft Store version, Windows manages this instead: Settings → Apps → Startup.)
- **Appearance:** style (Cozy, with warm colours and serif numbers, or Classic), theme (System, Dark or Light), accent colour, background opacity, size (80% to 250%), and resetting the widget's position.
- **Account:** sign in or out, choose the organization to show if your account has several, and open claude.ai.
- **About:** version and a link to this repository.

### Custom CSS

Want to restyle it beyond that? **Settings → Appearance → Custom CSS → Open CSS file** opens your own `theme.css`, which loads after the built-in styles. Save it and the widget updates within a second. Most changes only need a variable, for example:

```css
:root {
  --bg: rgba(30, 20, 45, 0.92);   /* panel background */
  --ok: #7dd3fc;                  /* bar colour under 60% */
  --warn: #fbbf24;                /* bar colour from 60% */
  --danger: #fb7185;              /* bar colour from 85% */
  --radius: 22px;                 /* corner rounding */
}
```

You can also restyle any element, for example `.peak { display: none; }`. To go back to the default look, empty the file.

## Privacy

- Your claude.ai sign-in stays on your computer, in the widget's own browser profile. Sign out in Settings to delete it.
- The widget only talks to claude.ai, to read your usage. No analytics, no telemetry, no third-party servers.
- It's open source, so you can read exactly what it does. See [PRIVACY.md](PRIVACY.md) for the full policy.

## Troubleshooting

- **The widget shows an error instead of numbers.** claude.ai's usage data isn't an official, documented API, so it can change without notice. The widget shows an error rather than wrong numbers; check for an update.
- **claude.ai shows a browser check.** Choose **Open claude.ai** in Settings → Account, let the page load, then click refresh.
- **Google sign-in is refused.** Some sign-in providers are strict about embedded browsers. Use the email option on the claude.ai sign-in page instead.
- **The widget doesn't line up exactly with my icons.** It asks Windows for your desktop icon spacing; with unusual auto-arrange settings it can be a few pixels off. Settings → About shows the tile size it detected.

Found a bug or have an idea? [Open an issue](../../issues). The code is MIT-licensed, so you're also free to take it and make it your own.

## Security

Found a security problem? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Thanks for checking it out! Bugs and ideas are always welcome.
