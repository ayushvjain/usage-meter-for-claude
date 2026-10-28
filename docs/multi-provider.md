# Reading usage from Claude, ChatGPT and Gemini

A plan for turning a Claude meter into one that covers all three assistants, and an honest
account of what each of them will actually tell us. Nothing here is built yet; the extension
ships Claude only.

_Last checked: 28 October 2026, ChatGPT's page confirmed from a signed-in account.
Everything below is undocumented product surface and can change without notice — treat the
dates as expiry dates, not footnotes._

## What each service exposes

| | Where usage comes from | What we can show | Confidence |
| --- | --- | --- | --- |
| **Claude** | `/api/organizations/<id>/usage` on paid plans; the `message_limit` event in the reply stream on Free | Percentage used and reset time, per window | **Built and working** |
| **ChatGPT** | A usage view in the product: `chatgpt.com/settings/usage` | 5-hour and weekly windows for Codex, Work, Workspace Agents and Excel. **Not chat** | **Confirmed, and it measures the wrong thing** |
| **Gemini** | A usage view in the product: Settings → Usage limits on `gemini.google.com` | Percentage of the current allowance and of the weekly limit, with reset times | **Likely** — needs one spike |

This supersedes an earlier assessment in which ChatGPT looked unreadable. At that point it
had no usage view at all; one has since appeared. It turns out to report something other
than what a ChatGPT user runs out of, which is a different problem and in some ways a worse
one. The lesson stands either way: re-check before building, not before planning.

### Claude

Two sources, both in use today. `/api/organizations/<id>/usage` returns each limit with a
percent and a reset time, and is authoritative for Pro, Max, Team and Enterprise. It answers
for Free accounts too but with nothing in it, so there the reply stream's `message_limit`
event is read instead — see [chrome-extension.md](chrome-extension.md).

### ChatGPT

A usage view exists at `chatgpt.com/settings/usage`, and it is readable: two meters, "5-hour
limit" and "Weekly limit", each with a percentage left and a reset countdown. The shape maps
onto our model exactly.

It measures the wrong thing. The page says so itself, under the heading *Plan limits*:

> Shared across Codex, Work, Workspace Agents, and ChatGPT for Excel.
> **Chat conversations are not included.**

So for someone who talks to ChatGPT — which is what almost everyone does, and what ran out
on the day this was investigated — these meters sit at 100% left and never move. Shipping
them labelled "ChatGPT" would be worse than shipping nothing: a meter reading full while
the user is locked out of the thing they are actually using.

**Decided: ship it, under the name of what it measures.** The point of this extension is
that nobody should have to open a settings page to find out where they stand, and that is
as true of a Codex limit as a chat one. So the meter goes in — labelled **"Codex & Work"**,
never "ChatGPT". The label is what keeps it honest: a full gauge next to that name is
information, while a full gauge next to "ChatGPT" is a lie to anyone who only chats.

Chat usage stays unmeasured for now, because there is nothing to measure it against:
OpenAI publishes no caps, they differ per plan and model and have moved several times this
year, so any percentage would be invented. What can be counted honestly — messages per
window, the model, and the lockout notice when it appears — is activity, not a limit. It
belongs in the report, which is built on activity anyway, and must never be drawn as a
gauge.

Known gap either way: the upload-rate quota is not shown anywhere, by OpenAI's own account.

### Gemini

Google documents the path in its own help pages: `gemini.google.com` → Settings → Usage
limits, showing how much of the current allowance and of the weekly limit has been used and
when each refreshes. Limits are **compute-based**, not a count of prompts — a Deep Research
run costs far more than a question — and Google publishes tiers as multipliers (AI Plus 2×,
AI Pro 4×, AI Ultra 5–20× Pro) rather than absolute numbers. Percentages and reset times are
therefore the only honest things to show, which is exactly what we display.

## The spike, before any of it is built

One session per provider, in a browser signed in to that account. For each:

1. Open the usage view with DevTools → Network recording, filtered to XHR/fetch.
2. Find the request that fills the panel. Record the URL, the method, and the response shape
   — specifically: where the percentage lives, whether it is a fraction or a whole number,
   whether the reset is an ISO string or unix seconds, and what distinguishes one window
   from another.
3. Reload with the panel closed. If the request only fires when the panel is open, note
   whether it can be made from a content script instead, and whether it needs anything the
   page holds (a session token in a header, a CSRF value).
4. Hit it twice a minute apart. Confirm the numbers move and the shape is stable.
5. Write the findings into this file, then build the adapter.

Stop at step 2 if the panel turns out to be server-rendered with no request behind it; the
fallback is reading the DOM of that page in a background tab, which is worse and should be
a deliberate decision, not a discovery made halfway through an implementation.

## Shape of the thing

### One model, three adapters

Every provider resolves to the limit shape the extension already uses, with a provider added:

```js
{ provider: 'claude' | 'chatgpt' | 'gemini',
  key, label, kind: 'session' | 'weekly', percent, resetsAt }
```

Everything downstream — the pace maths, the projection, the gauges, the history — already
works in those terms and needs no per-provider knowledge. An adapter's whole job is to turn
one service's answer into that list.

Adapters live beside the Claude one:

```
extension/providers/claude.js     the usage endpoint and the reply-stream reader
extension/providers/chatgpt.js    the usage view's request
extension/providers/gemini.js     the usage view's request
```

The worker keeps state per provider and refreshes each on its own schedule. The popup shows
a section per connected provider; the strip shows only the provider whose site it is on.

### What it costs

- **Permissions.** Three host permissions instead of one. The install warning becomes "read
  and change your data on chatgpt.com, claude.ai and gemini.google.com", which is a harder
  sell and draws more review attention. Make each one optional (`optional_host_permissions`)
  and request it when the user turns that provider on, so a Claude-only user grants nothing
  extra.
- **Breakage.** Three undocumented surfaces, each free to change. Budget for one of them
  being broken at any given time, and make a broken provider say so rather than show stale
  numbers — the failure mode this project has already hit twice.
- **The desktop widget cannot follow.** It has no page to watch and no session for these
  services. Multi-provider is extension-only, and the widget stays Claude-only.

## What the report is for

The reason to do any of this. Usage percentages are a now-number; the thing nobody ships is
the history: how heavily each service was used over weeks, when the peaks were, which ran
out first and how often. The samples needed for it are already being recorded per limit and
per window for Claude.

Built on **activity** — usage over time, per provider — the report works whatever a service
chooses to publish, so it degrades gracefully if one of them stops reporting percentages.
Export as CSV and JSON, locally, with no server anywhere.

## Order of work

1. **Ship Claude-only.** Done, bar the store listing.
2. **Provider-key the data model.** Cheap now, a rewrite later: add `provider` to limits and
   to the history store while there is only one value it can take.
3. **History and export.** The differentiator, and useful before any second provider exists.
4. **Spike Gemini**, then build the adapter if it pays off. Google documents the usage view,
   which makes it the better bet of the two.
5. **Codex & Work** (the ChatGPT page). Readable, and worth showing for the same reason as
   everything else here: so nobody has to open a settings page to see it. Needs the request
   behind that panel captured once — see the spike above. Chat activity, uncounted for now,
   joins the report later.
6. **Rename** only once a second provider actually works. "Usage Meter for Claude" with
   ChatGPT support is worse than either name chosen deliberately.

## Open questions

- ~~Does ChatGPT's usage view cover ordinary chat messages?~~ **Answered: no.** The page
  states that chat conversations are excluded.
- Does Gemini's view need a page-held token, or will cookies alone do from a content script?
- Is Gemini's allowance whole-account, or split by surface the way ChatGPT's turns out to be?
  Worth settling early, since the same trap applies: a meter that looks like it covers the
  chat may not.
- Gemini's compute-based limits have no prompt count. Does a percentage with no denominator
  read as useful, or as vague?
- Three providers in one strip, or one strip per site showing only that site? _(Current
  assumption: the latter.)_
