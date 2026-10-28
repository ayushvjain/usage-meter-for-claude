/*
 * Pure, dependency-free logic shared by the main process, the widget UI and the tests.
 * Loaded with require() in Node/Electron main, and with a <script> tag in the renderer
 * (where it becomes window.UsageCore).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsageCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // Peak hours as published on https://claude-peak-time.pages.dev/ :
  // Monday to Friday, 13:00 to 19:00 UTC. Days use getUTCDay() numbering (0 = Sunday).
  const DEFAULT_PEAK = Object.freeze({ days: [1, 2, 3, 4, 5], startHourUTC: 13, endHourUTC: 19 });

  const DEFAULT_REFRESH_MINUTES = 5;
  const MIN_REFRESH_MINUTES = 1;
  const MAX_REFRESH_MINUTES = 60;

  /* ---------- Peak hours ---------- */

  function utcMidnight(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  /** Every peak window [start, end) in ms that overlaps [fromMs, toMs]. */
  function peakWindows(fromMs, toMs, schedule) {
    const s = schedule || DEFAULT_PEAK;
    const out = [];
    for (let day = utcMidnight(fromMs) - DAY; day <= toMs + DAY; day += DAY) {
      if (!s.days.includes(new Date(day).getUTCDay())) continue;
      const start = day + s.startHourUTC * HOUR;
      const end = day + s.endHourUTC * HOUR;
      if (end > fromMs && start < toMs) out.push({ start, end });
    }
    return out;
  }

  /** { isPeak, nextChange: Date } for the given moment. */
  function getPeakStatus(now, schedule) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const windows = peakWindows(t, t + 8 * DAY, schedule);
    for (const w of windows) {
      if (t >= w.start && t < w.end) return { isPeak: true, nextChange: new Date(w.end) };
      if (w.start > t) return { isPeak: false, nextChange: new Date(w.start) };
    }
    return { isPeak: false, nextChange: null };
  }

  /** Peak segments of the viewer's local calendar day, as fractions 0..1 of that day. */
  function peakSegmentsForLocalDay(now, schedule) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const startOfDay = new Date(t);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const ls = startOfDay.getTime();
    const le = endOfDay.getTime();
    const span = le - ls;
    return peakWindows(ls, le, schedule).map((w) => ({
      from: (Math.max(w.start, ls) - ls) / span,
      to: (Math.min(w.end, le) - ls) / span,
    }));
  }

  /** Where "now" sits in the viewer's local day, 0..1. */
  function localDayFraction(now) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const startOfDay = new Date(t);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    return (t - startOfDay.getTime()) / (endOfDay.getTime() - startOfDay.getTime());
  }

  /* ---------- Usage parsing ---------- */

  /*
   * claude.ai's usage response comes in two shapes, often both at once:
   *
   * 1. A structured `limits` list. Each entry has a group ("session" or "weekly"), a
   *    percent, a reset time and, for scoped limits, a display name supplied by claude.ai
   *    (for example scope.surface.display_name = "Cowork", or a model name). This is the
   *    preferred source because claude.ai names each limit itself.
   *
   * 2. Older top-level keys such as five_hour, seven_day and seven_day_<name>, each
   *    { utilization, resets_at } or null. Used only when the list is missing or empty.
   *    Other top-level keys (internal codenames such as "tangelo") are ignored.
   */

  /*
   * Which assistant a limit belongs to. There is one value today, and adding the field while
   * that is true costs nothing; adding it once a second provider exists means touching the
   * history store, the trend keys and everything that reads them at the same time as writing
   * a new adapter. See docs/multi-provider.md.
   */
  const CLAUDE = 'claude';

  /** A limit's identity across providers: two services may both call something "session". */
  function limitId(limit) {
    return `${limit.provider || CLAUDE}:${limit.key}`;
  }

  const LEGACY_LABELS = {
    five_hour: 'Current session',
    seven_day: 'Weekly, all models',
    seven_day_oauth_apps: 'Weekly, connected apps',
  };

  function titleCase(text) {
    return text.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, value));
  }

  function displayName(part) {
    if (!part) return null;
    if (typeof part === 'string') return part;
    if (typeof part === 'object') return part.display_name || part.name || null;
    return null;
  }

  function scopeName(scope) {
    if (!scope || typeof scope !== 'object') return null;
    return displayName(scope.model) || displayName(scope.surface) || null;
  }

  function sortLimits(limits) {
    const rank = (l) => (l.kind === 'session' ? 0 : l.kind === 'weekly' && !l.scoped ? 1 : l.kind === 'weekly' ? 2 : 3);
    return limits.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }

  function parseLimitList(list) {
    const limits = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const percent = Number(item.percent);
      if (item.percent === null || item.percent === undefined || !Number.isFinite(percent)) continue;
      const group = String(item.group || item.kind || '');
      const name = scopeName(item.scope);
      let kind = 'other';
      let label;
      if (group === 'session') {
        kind = 'session';
        label = name ? `Session, ${name}` : 'Current session';
      } else if (group === 'weekly') {
        kind = 'weekly';
        label = name ? `Weekly, ${name}` : 'Weekly, all models';
      } else {
        const base = group ? titleCase(group.replace(/_/g, ' ')) : 'Limit';
        label = name ? `${base}, ${name}` : base;
      }
      limits.push({
        provider: CLAUDE,
        key: `${group || 'limit'}:${name || 'all'}`,
        label,
        kind,
        scoped: Boolean(name),
        percent: clampPercent(percent),
        resetsAt: typeof item.resets_at === 'string' ? item.resets_at : null,
      });
    }
    return limits;
  }

  function parseLegacyKeys(raw) {
    const limits = [];
    for (const [key, value] of Object.entries(raw)) {
      if (key !== 'five_hour' && !key.startsWith('seven_day')) continue;
      if (key === 'seven_day_breakdown') continue;
      if (!value || typeof value !== 'object') continue;
      const util = Number(value.utilization);
      if (value.utilization === null || value.utilization === undefined || !Number.isFinite(util)) continue;
      const suffix = key.startsWith('seven_day_') ? key.slice('seven_day_'.length) : '';
      limits.push({
        provider: CLAUDE,
        key,
        label: LEGACY_LABELS[key] || 'Weekly, ' + titleCase(suffix.replace(/_/g, ' ')),
        kind: key === 'five_hour' ? 'session' : 'weekly',
        scoped: Boolean(suffix),
        percent: clampPercent(util),
        resetsAt: typeof value.resets_at === 'string' ? value.resets_at : null,
      });
    }
    return limits;
  }

  /** Turns the claude.ai usage response into a sorted list of limits to draw. */
  function parseUsage(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Usage response was not an object.');
    }
    const fromList = Array.isArray(raw.limits) ? parseLimitList(raw.limits) : [];
    return sortLimits(fromList.length ? fromList : parseLegacyKeys(raw));
  }

  /* ---------- Usage from the chat stream (Free accounts) ---------- */

  /*
   * Free accounts are entitled to /api/organizations/<id>/usage — it answers 200 — but
   * claude.ai puts nothing in it: every bucket null and an empty `limits` list. The figures
   * do exist, in the chat stream: each reply carries a `message_limit` event with a
   * `windows` map, and claude.ai keeps sending it on Free. Reading it needs a page to watch,
   * so only the browser extension can; the desktop widget has no claude.ai tab to listen to.
   *
   * Two conventions differ from /usage, and both are easy to get wrong:
   *   utilization is a fraction (0.62), where /usage reports a percent (62).
   *   resets_at is unix seconds, where /usage reports an ISO string.
   */

  const STREAM_WINDOWS = Object.freeze({
    '5h': { key: 'stream:5h', kind: 'session', label: 'Current session' },
    '7d': { key: 'stream:7d', kind: 'weekly', label: 'Weekly, all models' },
  });

  /** True when /usage answered, but with nothing in it: an account claude.ai doesn't meter. */
  function looksUnmetered(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    // Must be the usage envelope itself, not some other 200.
    if (!('limits' in raw || 'five_hour' in raw || 'seven_day' in raw)) return false;
    if (Array.isArray(raw.limits) && raw.limits.length > 0) return false;
    for (const value of Object.values(raw)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'boolean' || typeof value === 'string') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === 'object' && Object.keys(value).length === 0) continue;
      return false; // something substantive is there, so the account is metered
    }
    return true;
  }

  /**
   * Turns a `message_limit` event's `windows` map into the same limits the rest of the app
   * draws. Windows other than the 5-hour and the weekly one are left out: `7d_oi` belongs to
   * whichever model served that one request, which the stream never names, and `overage` is
   * paid extra usage, which a Free account cannot have.
   */
  function parseStreamWindows(windows) {
    if (!windows || typeof windows !== 'object') return [];
    const limits = [];
    for (const [name, spec] of Object.entries(STREAM_WINDOWS)) {
      const win = windows[name];
      if (!win || typeof win !== 'object') continue;
      const utilization = Number(win.utilization);
      if (!Number.isFinite(utilization)) continue;
      const resetsAt = Number(win.resets_at);
      // A window that is out of messages still reports a fraction below one, so the status
      // decides: "98%" beside a composer that refuses to send reads as a broken meter.
      const exceeded = win.status === 'exceeded_limit';
      limits.push({
        provider: CLAUDE,
        key: spec.key,
        label: spec.label,
        kind: spec.kind,
        scoped: false,
        percent: exceeded ? 100 : clampPercent(Math.round(utilization * 100)),
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : null,
      });
    }
    return sortLimits(limits);
  }

  /**
   * Keeps the higher reading for a window that is still the same one. Usage only climbs
   * within a window, and both sides round independently, so a dip is noise; a genuine reset
   * arrives with a new reset time, which is what tells the two apart. Windows whose reset has
   * passed are dropped rather than shown stale, since nothing can refresh them but a message.
   */
  function mergeStreamLimits(previous, incoming, now = Date.now()) {
    const SAME_WINDOW_MS = 5 * 60 * 1000;
    const byKey = new Map();
    for (const limit of previous || []) byKey.set(limit.key, limit);
    for (const limit of incoming || []) {
      const old = byKey.get(limit.key);
      const sameWindow =
        old && Math.abs(new Date(old.resetsAt || 0).getTime() - new Date(limit.resetsAt || 0).getTime()) < SAME_WINDOW_MS;
      byKey.set(limit.key, sameWindow && limit.percent < old.percent ? old : limit);
    }
    const live = [...byKey.values()].filter((l) => !l.resetsAt || new Date(l.resetsAt).getTime() > now);
    return sortLimits(live);
  }

  /* ---------- How fast a limit is being used ---------- */

  /*
   * A percentage on its own says where you are, not where you are heading. Keeping a short
   * history of readings answers the two questions people actually have: how fast am I going
   * through this window, and when do I run out if I carry on like this.
   *
   * Readings are kept per limit and per window: a reset starts a new window, and rates must
   * never be measured across one. Only the last few hours are kept — a 5-hour window cannot
   * use more than that, and the weekly one is read often enough that older points add
   * nothing but storage.
   */

  /*
   * How long each kind of window runs. claude.ai reports when a window resets but never how
   * long it is, and the lengths are fixed: the session is five hours, the weekly limits are
   * seven days. Knowing both gives the elapsed time, and with it an average pace that is
   * available from the first reading instead of after several.
   */
  const WINDOW_MS = Object.freeze({ session: 5 * HOUR, weekly: 7 * DAY });
  const MIN_ELAPSED_MS = 3 * MINUTE; // dividing by the first seconds of a window is nonsense

  const TREND_MAX_AGE_MS = 8 * HOUR;
  const TREND_MIN_SPAN_MS = 4 * MINUTE; // below this the arithmetic is mostly rounding noise

  /** Adds a reading, drops what is too old, and starts fresh when the window resets. */
  function recordSample(history, { percent, resetsAt, at }) {
    const samples = Array.isArray(history) ? history.slice() : [];
    const value = Number(percent);
    if (!Number.isFinite(value)) return samples;
    const time = Number(at) || Date.now();
    const window = resetsAt || null;

    const sameWindow = samples.length === 0 || samples[samples.length - 1].window === window;
    const kept = (sameWindow ? samples : []).filter((s) => time - s.at < TREND_MAX_AGE_MS);

    const last = kept[kept.length - 1];
    /* Readings arrive every few minutes and mostly repeat, so only movement is kept as a
       point. A repeat extends the last one instead: without that, a limit that has not
       moved for an hour collapses to a single reading, and "not moving" becomes
       indistinguishable from "nothing measured yet". */
    if (last && last.percent === value) {
      last.until = time;
      return kept;
    }
    kept.push({ at: time, until: time, percent: value, window });
    return kept;
  }

  /**
   * Percentage points per hour, measured over the readings inside `spanMs`, or null when
   * there is not enough history yet to say anything honest.
   */
  function usageRate(history, { spanMs = 60 * MINUTE, now = Date.now() } = {}) {
    const all = Array.isArray(history) ? history : [];
    const samples = all.filter((s) => now - s.at <= spanMs);
    const endOf = (sample) => sample.until || sample.at;

    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const elapsed = endOf(last) - first.at;
      if (elapsed < TREND_MIN_SPAN_MS) return null;
      const climb = last.percent - first.percent;
      // A dip is two roundings disagreeing, not usage going backwards.
      return climb > 0 ? (climb / elapsed) * HOUR : 0;
    }

    // One reading that has stood still long enough is a real answer: nothing is being used.
    const latest = all[all.length - 1];
    if (latest && endOf(latest) - latest.at >= TREND_MIN_SPAN_MS) return 0;
    return null;
  }

  /**
   * The average pace since this window began: what has been used, over how long it has been
   * running. Unlike usageRate it needs no history at all, so it can answer immediately, and
   * it falls on its own while nothing is being used — which is the honest picture of an
   * average. null when the window length or its reset is unknown, or it has only just begun.
   */
  function averageRate({ percent, resetsAt, kind, windowMs = null, now = Date.now() }) {
    // A provider that reports its own window length is believed over the fixed table, which
    // exists only because claude.ai does not report one.
    const length = windowMs || WINDOW_MS[kind];
    if (!length || !resetsAt) return null;
    const reset = new Date(resetsAt).getTime();
    if (!Number.isFinite(reset)) return null;
    const elapsed = length - (reset - now);
    if (!(elapsed >= MIN_ELAPSED_MS) || elapsed > length) return null;
    const used = Number(percent);
    if (!Number.isFinite(used) || used < 0) return null;
    return (used / elapsed) * HOUR;
  }

  /**
   * How long until this limit reaches 100% at that rate, in ms. null when it is not moving,
   * when there is no rate yet, or when the window resets before it would run out — in which
   * case the reset, not the rate, is what matters.
   */
  function timeToLimit({ percent, ratePerHour, resetsAt = null, now = Date.now() }) {
    const left = 100 - Number(percent);
    if (!(ratePerHour > 0) || !(left > 0)) return null;
    const ms = (left / ratePerHour) * HOUR;
    if (resetsAt) {
      const reset = new Date(resetsAt).getTime();
      if (Number.isFinite(reset) && reset - now <= ms) return null;
    }
    return ms;
  }

  /* ---------- ChatGPT: the plan limits behind its Usage page ---------- */

  /*
   * ChatGPT answers with both windows in one object, and unlike claude.ai it says how long
   * each window is, so nothing has to be assumed to work out a pace:
   *
   *   rate_limit.primary_window   { used_percent, limit_window_seconds, reset_at }   5 hours
   *   rate_limit.secondary_window { ... }                                            7 days
   *
   * used_percent is a whole number (0-100), reset_at is unix seconds, and the window kind is
   * read from its own length rather than its field name, so a change from five hours to
   * three needs no code.
   *
   * These meters cover Codex, Work, Workspace Agents and ChatGPT for Excel. Chat
   * conversations are NOT in them — the Usage page says so itself — which is why the labels
   * name those surfaces instead of saying "ChatGPT". A full gauge beside the wrong name
   * would read as "you have plenty left" to someone who had just been cut off mid-chat.
   */

  const CHATGPT = 'chatgpt';
  const CHATGPT_SCOPE = 'Codex & Work';

  function chatgptLabel(windowMs) {
    if (!windowMs) return CHATGPT_SCOPE;
    if (windowMs >= 6 * DAY) return `${CHATGPT_SCOPE}, weekly`;
    if (windowMs >= DAY) return `${CHATGPT_SCOPE}, ${Math.round(windowMs / DAY)}-day`;
    return `${CHATGPT_SCOPE}, ${Math.round(windowMs / HOUR)}-hour`;
  }

  /** The limits from ChatGPT's usage response, in the shape the rest of the app draws. */
  function parseChatgptUsage(raw, now = Date.now()) {
    const rate = raw && typeof raw === 'object' ? raw.rate_limit : null;
    if (!rate || typeof rate !== 'object') return [];

    const limits = [];
    for (const field of ['primary_window', 'secondary_window']) {
      const win = rate[field];
      if (!win || typeof win !== 'object') continue;
      const percent = Number(win.used_percent);
      if (!Number.isFinite(percent)) continue;

      const seconds = Number(win.limit_window_seconds);
      const windowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      const resetAt = Number(win.reset_at);
      const after = Number(win.reset_after_seconds);
      const resetsAt =
        Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toISOString()
        : Number.isFinite(after) && after >= 0 ? new Date(now + after * 1000).toISOString()
        : null;

      limits.push({
        provider: CHATGPT,
        key: `window:${field.replace('_window', '')}`,
        label: chatgptLabel(windowMs),
        // By length, not by name: "primary" is only the shorter of the two.
        kind: windowMs && windowMs <= DAY ? 'session' : 'weekly',
        scoped: false,
        percent: clampPercent(percent),
        resetsAt,
        windowMs,
      });
    }
    return sortLimits(limits);
  }

  /**
   * The rest of that response: what plan it is, whether the limit has been hit, and the
   * credits that keep Codex and Work running once it has. Separate from the limits because
   * it is not a gauge — it is the context around one.
   */
  function parseChatgptStatus(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rate = raw.rate_limit || {};
    const credits = raw.credits || {};
    const resets = raw.rate_limit_reset_credits || {};
    const balance = Number(credits.balance);
    return {
      provider: CHATGPT,
      plan: typeof raw.plan_type === 'string' ? raw.plan_type : null,
      limitReached: Boolean(rate.limit_reached) || Boolean(credits.overage_limit_reached),
      reachedType: typeof raw.rate_limit_reached_type === 'string' ? raw.rate_limit_reached_type : null,
      credits: {
        unlimited: Boolean(credits.unlimited),
        balance: Number.isFinite(balance) ? balance : null,
      },
      resetCredits: Number(resets.available_count) || 0,
    };
  }

  /* ---------- Organizations ---------- */

  /**
   * Organizations that have claude.ai plan limits. API-only organizations (the Claude
   * Console kind, without the "chat" capability) have no session or weekly limits, so
   * they are left out.
   */
  function chatOrgs(orgs) {
    return (Array.isArray(orgs) ? orgs : []).filter(
      (o) => o && o.uuid && Array.isArray(o.capabilities) && o.capabilities.includes('chat'),
    );
  }

  /**
   * Decides which organization to show.
   * - { type: 'none' }               the account has no claude.ai organization
   * - { type: 'single', uuid }       exactly one, so show it without asking
   * - { type: 'chosen', uuid }       several, and the user already picked one that still exists
   * - { type: 'choose', orgs }       several and no valid pick yet, so ask the user
   */
  function resolveOrg({ orgs, pinnedId }) {
    const list = chatOrgs(orgs);
    if (list.length === 0) return { type: 'none' };
    if (list.length === 1) return { type: 'single', uuid: list[0].uuid };
    if (pinnedId && list.some((o) => o.uuid === pinnedId)) return { type: 'chosen', uuid: pinnedId };
    return { type: 'choose', orgs: list };
  }

  function levelFor(percent, thresholds) {
    const warnAt = (thresholds && thresholds.warnAt) || 60;
    const dangerAt = (thresholds && thresholds.dangerAt) || 85;
    if (percent >= dangerAt) return 'danger';
    if (percent >= warnAt) return 'warn';
    return 'ok';
  }

  /* ---------- Formatting ---------- */

  /** "3d 4h", "2h 14m", "45m", "<1m". */
  function formatDuration(ms) {
    if (!(ms > 0)) return '0m';
    const totalMinutes = Math.floor(ms / MINUTE);
    if (totalMinutes < 1) return '<1m';
    const d = Math.floor(totalMinutes / 1440);
    const h = Math.floor((totalMinutes % 1440) / 60);
    const m = totalMinutes % 60;
    if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  /** "4:05" or "1:02:09", for short countdowns. */
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function clampRefreshMinutes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_REFRESH_MINUTES;
    return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, Math.round(n)));
  }

  /* ---------- Desktop layer (Windows) ---------- */

  // SetWindowPos "insert after" value that means the top of the normal (non-topmost) band.
  const HWND_TOP = 0;
  const DESKTOP_CLASSES = ['Progman', 'WorkerW'];

  /**
   * Decides where the widget window should sit so it lives on the desktop: directly above
   * the Windows desktop (wallpaper and icons) and below every app window.
   *
   * Windows keeps top-level windows in one stack. The desktop itself is made of shell
   * windows of class "Progman" and "WorkerW" at the bottom of that stack. When the user
   * presses Win+D (Show desktop), Windows raises a desktop window above the apps and gives
   * it focus, so the widget follows it up and stays visible.
   *
   * Inputs are plain functions so this can be tested without Windows:
   *   self         the widget's window handle
   *   foreground   the last focused window that isn't the widget or the taskbar
   *   progman      the main desktop window (FindWindow "Progman"), or 0
   *   classOf(h)   window class name of h
   *   windowAbove(h)  the window directly above h in the stack, or 0
   *
   * Returns { action: 'none' } when the widget is already in place, or
   * { action: 'place', insertAfter } for SetWindowPos(self, insertAfter, ...), which puts
   * the widget directly below insertAfter (that is, directly above the desktop).
   */
  function planDesktopPlacement({ self, foreground, progman, classOf, windowAbove }) {
    const isDesktop = (h) => Boolean(h) && DESKTOP_CLASSES.includes(classOf(h));
    let anchor = isDesktop(foreground) ? foreground : progman;
    if (!anchor) return { action: 'none' };

    // The desktop can be several shell windows stacked together; sit above all of them.
    for (let guard = 0; guard < 64; guard += 1) {
      const above = windowAbove(anchor);
      if (above && above !== self && isDesktop(above)) anchor = above;
      else break;
    }

    const above = windowAbove(anchor);
    if (above === self) return { action: 'none' };
    return { action: 'place', insertAfter: above || HWND_TOP };
  }

  /* ---------- Desktop grid (snap like icons) ---------- */

  const FALLBACK_CELL = Object.freeze({ w: 75, h: 75 });

  // Widget widths in desktop-icon tiles.
  // The narrowest the widget gets, in desktop-icon tiles, so text never gets squeezed. Above
  // that it is as wide as its content is tall, so it stays square whatever the account shows.
  const MIN_TILES = 3;

  /**
   * Turns the desktop list view's LVM_GETITEMSPACING result (cell width in the low word,
   * height in the high word, physical pixels) into a cell size in device-independent pixels.
   */
  function decodeItemSpacing(lresult, scaleFactor) {
    const value = Number(lresult);
    if (!Number.isFinite(value) || value <= 0) return null;
    const scale = scaleFactor > 0 ? scaleFactor : 1;
    const w = Math.round((value & 0xffff) / scale);
    const h = Math.round(((value >>> 16) & 0xffff) / scale);
    if (w < 32 || h < 32 || w > 400 || h > 400) return null;
    return { w, h };
  }

  /**
   * Window size for the widget. The content is one column, so its height decides the size:
   * the window is exactly as tall as the content (no spare space anywhere) and as wide as it
   * is tall, so it is square for every plan. It is never narrower than `minTiles` desktop
   * tiles, or than its longest line (`contentWidth`), since text doesn't wrap. The position
   * still snaps to the icon grid (see snapToGrid). `inset` is the transparent margin around
   * the panel inside the window. `scale` is the user's size setting: the content is measured
   * at 100% and drawn at this zoom, so the window grows by the same factor.
   */
  function gridLayout({ cell, minTiles, contentHeight, contentWidth = 0, inset, scale = 1 }) {
    const c = cell || FALLBACK_CELL;
    const z = clampScale(scale);
    const pad = 2 * (inset || 0) * z;
    const min = Math.max(1, Math.round(minTiles || MIN_TILES)) * c.w;
    const height = Math.max(1, Math.ceil(Math.max(0, contentHeight) * z + pad));
    const widest = Math.ceil(Math.max(0, contentWidth) * z + pad);
    const width = Math.max(min, height, widest);
    return { width, height };
  }

  /**
   * Snaps one axis: to the nearest tile, or flush with the far edge of the screen.
   * The widget is rarely a whole number of tiles, so the last tile that fits can leave a
   * strip of up to one tile at the right or bottom edge. Dropping the widget nearer the
   * edge than that last tile puts it flush against the edge, so it can sit in any corner.
   */
  function snapAxis(pos, size, start, length, step) {
    const maxGrid = start + Math.max(0, Math.floor((length - size) / step)) * step;
    const edge = start + Math.max(0, length - size);
    const nearest = start + Math.round((pos - start) / step) * step;
    const onGrid = Math.min(Math.max(nearest, start), maxGrid);
    if (edge > onGrid && Math.abs(pos - edge) < Math.abs(pos - onGrid)) return edge;
    return onGrid;
  }

  /** Nearest tile position (or screen edge) for a window, kept fully inside the work area. */
  function snapToGrid({ x, y, width, height }, area, cell) {
    const c = cell || FALLBACK_CELL;
    return {
      x: snapAxis(x, width, area.x, area.width, c.w),
      y: snapAxis(y, height, area.y, area.height, c.h),
    };
  }


  /** The top-left tile of the screen, used when the widget has never been placed or is reset. */
  function defaultTile({ width, height }, area, cell) {
    return snapToGrid({ x: area.x, y: area.y, width, height }, area, cell);
  }

  /* ---------- Appearance ---------- */

  const THEMES = Object.freeze(['system', 'dark', 'light']);
  // Cozy: warm paper colours, serif numbers and hand-drawn lines. Classic: the original look.
  const STYLES = Object.freeze(['cozy', 'classic']);
  const ACCENTS = Object.freeze(['clay', 'teal', 'blue', 'violet', 'amber', 'rose']);
  const OPACITY_RANGE = Object.freeze({ min: 60, max: 100 });

  // The widget's size as a zoom: 100% is the default. Bigger screens can go up to 250%.
  const SCALE_RANGE = Object.freeze({ min: 0.8, max: 2.5, step: 0.05 });

  /** Keeps a size within range, rounded to 5% steps so saved values stay tidy. */
  function clampScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 1;
    const stepped = Math.round(n / SCALE_RANGE.step) * SCALE_RANGE.step;
    return Math.round(Math.min(SCALE_RANGE.max, Math.max(SCALE_RANGE.min, stepped)) * 100) / 100;
  }

  /* ---------- Refresh scheduling ---------- */

  /**
   * Runs `task` now and then every `intervalMs`. Any refresh (automatic or manual)
   * restarts the countdown, so the next automatic refresh is always a full interval
   * after the most recent one finished. Overlapping calls share one in-flight run.
   */
  class RefreshScheduler {
    constructor(options) {
      this.intervalMs = options.intervalMs;
      this.task = options.task;
      this.now = options.now || Date.now;
      this.setTimer = options.setTimer || setTimeout;
      this.clearTimer = options.clearTimer || clearTimeout;
      this.onScheduled = options.onScheduled || null;
      this.timer = null;
      this.inFlight = null;
      this.nextAt = null;
      this.stopped = false;
    }

    start() {
      this.stopped = false;
      return this.refreshNow('startup');
    }

    refreshNow(reason) {
      if (this.inFlight) return this.inFlight;
      this._clear();
      this.inFlight = (async () => {
        try {
          await this.task(reason || 'manual');
        } finally {
          this.inFlight = null;
          if (!this.stopped) this._schedule();
        }
      })();
      return this.inFlight;
    }

    setIntervalMs(ms) {
      this.intervalMs = ms;
      if (!this.inFlight && !this.stopped) this._schedule();
    }

    stop() {
      this.stopped = true;
      this._clear();
      this.nextAt = null;
    }

    _clear() {
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
    }

    _schedule() {
      this._clear();
      this.nextAt = this.now() + this.intervalMs;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.refreshNow('auto');
      }, this.intervalMs);
      if (this.onScheduled) this.onScheduled(this.nextAt);
    }
  }

  return {
    DEFAULT_PEAK,
    DEFAULT_REFRESH_MINUTES,
    getPeakStatus,
    peakSegmentsForLocalDay,
    localDayFraction,
    parseUsage,
    parseChatgptUsage,
    parseChatgptStatus,
    limitId,
    WINDOW_MS,
    recordSample,
    usageRate,
    averageRate,
    timeToLimit,
    looksUnmetered,
    parseStreamWindows,
    mergeStreamLimits,
    chatOrgs,
    resolveOrg,
    levelFor,
    formatDuration,
    formatClock,
    clampRefreshMinutes,
    RefreshScheduler,
    HWND_TOP,
    planDesktopPlacement,
    FALLBACK_CELL,
    MIN_TILES,
    decodeItemSpacing,
    gridLayout,
    snapToGrid,
    defaultTile,
    THEMES,
    STYLES,
    ACCENTS,
    OPACITY_RANGE,
    SCALE_RANGE,
    clampScale,
  };
});
