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
    chatOrgs,
    resolveOrg,
    levelFor,
    formatDuration,
    formatClock,
    clampRefreshMinutes,
    RefreshScheduler,
    HWND_TOP,
    planDesktopPlacement,
  };
});