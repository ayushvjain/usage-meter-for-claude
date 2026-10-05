# Usage Meter for Claude

A small Windows desktop widget that shows how much of your Claude plan you have used, when each limit resets, and whether Claude's peak hours are on right now.

It works with Free, Pro and Max accounts. The widget shows whichever limits claude.ai reports for your account: the 5-hour session, the weekly limit, and any per-model weekly limits.

<p>
  <img src="docs/screenshot-dark.png" width="320" alt="Widget in dark mode" />
  <img src="docs/screenshot-light.png" width="320" alt="Widget in light mode" />
</p>

> Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.

## What it shows

- **Current session** (the 5-hour window): percent used and time until it resets.
- **Weekly limits**: every weekly bar your account has, each with its reset day and countdown.
- **Peak hours**: whether peak hours are active, a countdown to the next change, and a strip showing today's peak window in your local time. The schedule is Monday to Friday, 13:00 to 19:00 UTC, as published on [claude-peak-time.pages.dev](https://claude-peak-time.pages.dev/). Turn it off from the menu if it doesn't apply to your plan.

Your claude.ai chats, the Claude desktop app and Claude Code all draw from the same limits, so these numbers cover all of them.

## Refreshing

- The widget refreshes every 5 minutes by default. Change this from the menu under **Refresh every** (1 to 30 minutes).
- Click the refresh button to refresh immediately. The next automatic refresh then happens a full interval after your manual one, so a manual refresh always restarts the countdown.
- The footer shows when the data was last updated and when the next refresh is due.

## Install

Download the latest installer from [Releases](../../releases), or get it from the Microsoft Store (once published).

On first launch, click **Sign in** and sign in to claude.ai in the window that opens. The window closes on its own once you're signed in.

The widget lives in the system tray. Click the tray icon to show or hide it, and right-click it (or click the `⋯` button on the widget) for the menu. Drag the widget by its title to move it. It remembers where you put it.

## Make it yours

The look is plain CSS. Open the menu and choose **Edit theme…**. That opens your personal `theme.css`, which loads after the built-in styles. Save it and the widget updates within a second.

Most changes only need a variable:

```css
:root {
  --bg: rgba(30, 20, 45, 0.92);   /* panel background */
  --ok: #7dd3fc;                  /* bar colour under the warning threshold */
  --warn: #fbbf24;                /* bar colour from 60% */
  --danger: #fb7185;              /* bar colour from 85% */
  --radius: 22px;                 /* corner rounding */
  --hero-size: 40px;              /* size of the session percentage */
}
```

| Variable | What it changes |
| --- | --- |
| `--bg`, `--border`, `--radius`, `--pad` | Panel background, outline, corner rounding, inner spacing |
| `--font`, `--font-numbers` | Text font and the font used for percentages |
| `--text`, `--muted` | Main text and secondary text colours |
| `--hero-size` | Size of the session percentage |
| `--track`, `--bar-height`, `--hero-bar-height` | Bar background and bar thickness |
| `--ok`, `--warn`, `--danger` | Bar colours by level |
| `--peak`, `--off-peak` | Peak-hours dot and strip colours |

You can also restyle any element, for example `.peak { display: none; }` or `.footer { opacity: 0.6; }`. To go back to the default look, empty the file.

The theme file lives in `%APPDATA%\Usage Meter for Claude\theme.css` (Store builds keep it inside the app's package folder, so use **Edit theme…** to find it). Share themes by sharing that file.

Other settings are stored next to it in `config.json`. The menu covers all of them; if you edit the file by hand, restart the widget. `warnAt` and `dangerAt` set the bar colour thresholds in percent.

## How it works

claude.ai has a private endpoint that powers its own Usage page:

```
GET https://claude.ai/api/organizations/<org_id>/usage
```

The widget keeps your claude.ai sign-in in its own browser profile (an Electron session partition), like a separate browser. A hidden window on the claude.ai origin calls that endpoint, so requests behave like a normal browser tab.

The response includes a `limits` list. Each entry has a group (`session` or `weekly`), a percent, a reset time and, for limits that apply to one model or product, a name supplied by claude.ai (for example "Cowork"). The widget draws one bar per entry, so every plan, and any new model or product limit, shows up without code changes. If the list is missing or empty, the widget falls back to the older `five_hour` and `seven_day_<name>` keys. Other keys in the response are ignored.

### Accounts with more than one organization

Many people belong to several organizations, such as a personal plan and a work or university Enterprise seat. Each one has its own limits, so the widget never guesses:

- With **one** claude.ai organization, the widget shows it straight away.
- With **two or more**, the widget asks which one to show and remembers the choice. The organization currently selected on claude.ai is marked to help you pick. Change it later under **Organization** in the menu. The chosen organization's name appears under the widget title.
- API-only organizations (Claude Console accounts) have no session or weekly limits, so they are never listed.
- If you leave the chosen organization, the widget asks again. Signing out clears the choice.

All claude.ai logic lives in `src/main/claude.js`, and response parsing lives in `src/shared/core.js`. If claude.ai changes its endpoints, those are the files to fix. `test/fixtures/` holds real responses for the tests.

### Privacy

- Your session stays on your computer, in the widget's own profile. Sign out from the menu to delete it.
- The widget only talks to claude.ai. No analytics, no telemetry, no third-party servers.
- The code is small and open; read it.

### Known limits

- The endpoint is undocumented and can change without notice. When it does, the widget shows an error instead of wrong numbers.
- If claude.ai shows a browser check, choose **Open claude.ai** from the menu, let the page load, then refresh.
- Some sign-in providers are strict about embedded browsers. If Google sign-in is refused, use the email option on the claude.ai sign-in page.

## Develop

Requires Node.js 20 or newer.

```bash
npm install
npm start      # run the widget
npm test       # logic tests and a syntax check of every source file
```

Project layout:

```
src/
  main/
    main.js              app lifecycle, widget window, tray menu, refresh scheduling
    claude.js            sign-in window and claude.ai requests
    config.js            settings file
    preload.js           the small API the widget page can call
    theme-template.css   copied to the user's theme.css on first run
  renderer/
    index.html           widget markup
    styles.css           built-in styles (all values are CSS variables)
    renderer.js          rendering and live countdowns
  shared/
    core.js              pure logic: peak hours, usage parsing, formatting, refresh scheduler
test/
  core.test.js           logic tests and a syntax check of every source file
  fixtures/              real claude.ai usage responses used by the tests
```

`src/shared/core.js` has no dependencies and is loaded by both the main process and the widget, so the tests cover the same code the app runs.

## Build installers

```bash
npm run dist         # dist/Usage Meter for Claude Setup <version>.exe, for GitHub Releases
npm run dist:store   # dist/*.appx, for the Microsoft Store
```

### Publishing to the Microsoft Store

1. Create a Microsoft Partner Center developer account and reserve the app name.
2. In Partner Center, open **Product identity** and copy the package identity name, publisher ID (`CN=…`) and publisher display name into the `build.appx` section of `package.json`.
3. Run `npm run dist:store` and upload the `.appx` from `dist/`. The Store signs it for you.
4. Store tiles come from `build/appx/`. Replace those PNGs with your own artwork if you like.
5. In the listing, say clearly that the app is not affiliated with Anthropic.

In Store builds, "Start with Windows" is managed by Windows (Settings > Apps > Startup), so that menu item is disabled there.

Before your first release, replace `REPLACE_WITH_YOUR_GITHUB_USERNAME` in `src/main/main.js` with your GitHub username so **About and source code** opens your repo.

## Verify a build

1. `npm test` passes (31 tests).
2. `npm start`, then sign in. If your account has several organizations, pick one. The session, weekly and peak sections appear, and the footer counts down from "Next refresh in 5:00".
3. Wait a minute and click refresh. The footer jumps back to about "Next refresh in 5:00" instead of continuing the old countdown.
4. Choose **Edit theme…**, set `--ok: hotpink;` and save. The session bar turns pink within a second.
5. Choose **Sign out**. The widget asks you to sign in again.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
