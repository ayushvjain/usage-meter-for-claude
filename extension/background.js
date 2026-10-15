'use strict';

/*
 * The extension's background service worker.
 *
 * It owns everything the popup should not have to redo each time it opens: the settings,
 * the last usage it fetched, and the timer that refreshes it. The popup asks for the
 * current state when it opens and then listens for updates, so it draws instantly even
 * though the worker may have been asleep a moment earlier.
 *
 * Usage comes from the same private claude.ai endpoints the Usage page uses. Requests are
 * made with the browser's own claude.ai cookies (host_permissions covers https://claude.ai/*),
 * so there is no separate sign-in: if the user is signed in to claude.ai in this browser,
 * the extension can read their usage. If they are not, the popup offers to open claude.ai.
 */

importScripts('shared/core.js');

const core = self.UsageCore;

const BASE = 'https://claude.ai';
const ORG_LIST_TTL_MS = 30 * 60 * 1000;
const ALARM = 'refresh';
const SETTINGS_KEY = 'settings';
const STATE_KEY = 'state';

const DEFAULT_SETTINGS = Object.freeze({
  refreshMinutes: core.DEFAULT_REFRESH_MINUTES,
  showPeakHours: true,
  style: 'cozy',
  theme: 'system',
  accent: 'clay',
  scale: 1,
  showBadge: true,
  warnAt: 60,
  dangerAt: 85,
  orgId: null,
  customCss: '',
});

const EMPTY_STATE = Object.freeze({
  status: 'loading',
  limits: [],
  fetchedAt: null,
  nextRefreshAt: null,
  message: null,
  org: null,
  orgCount: 0,
  orgChoices: [],
  orgs: [],
});

/* ---------- Settings ---------- */

function cleanSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
  s.refreshMinutes = core.clampRefreshMinutes(s.refreshMinutes);
  s.showPeakHours = Boolean(s.showPeakHours);
  s.showBadge = Boolean(s.showBadge);
  s.style = core.STYLES.includes(s.style) ? s.style : DEFAULT_SETTINGS.style;
  s.theme = core.THEMES.includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme;
  s.accent = core.ACCENTS.includes(s.accent) ? s.accent : DEFAULT_SETTINGS.accent;
  s.scale = core.clampScale(s.scale);
  s.warnAt = Number.isFinite(Number(s.warnAt)) ? Number(s.warnAt) : DEFAULT_SETTINGS.warnAt;
  s.dangerAt = Number.isFinite(Number(s.dangerAt)) ? Number(s.dangerAt) : DEFAULT_SETTINGS.dangerAt;
  s.orgId = typeof s.orgId === 'string' && s.orgId ? s.orgId : null;
  s.customCss = typeof s.customCss === 'string' ? s.customCss.slice(0, 20000) : '';
  return s;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return cleanSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

/* ---------- Cached state ---------- */

async function loadState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...EMPTY_STATE, ...(stored[STATE_KEY] || {}) };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

/** Saves the state, tells any open popup about it, and updates the toolbar badge. */
async function setState(patch) {
  const next = { ...(await loadState()), ...patch };
  await saveState(next);
  const settings = await loadSettings();
  await paintBadge(next, settings);
  // No receiver while the popup is closed: that is normal, not an error.
  chrome.runtime.sendMessage({ type: 'state', state: next, settings }).catch(() => {});
  return next;
}

/* ---------- Toolbar badge ---------- */

const BADGE_COLOURS = { ok: '#3f7f6f', warn: '#b8801c', danger: '#b84a33' };

async function paintBadge(state, settings) {
  const session = state.limits.find((l) => l.kind === 'session') || state.limits[0];
  if (!settings.showBadge || !session || state.status === 'auth') {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const level = core.levelFor(session.percent, settings);
  await chrome.action.setBadgeText({ text: String(Math.round(session.percent)) });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOURS[level] });
}

/* ---------- claude.ai ---------- */

class AuthError extends Error {
  constructor() {
    super('Sign in to claude.ai to see your session and weekly limits.');
    this.name = 'AuthError';
  }
}

class BlockedError extends Error {
  constructor() {
    super('claude.ai asked for a browser check. Open claude.ai in a tab, then refresh.');
    this.name = 'BlockedError';
  }
}

class NoPlanError extends Error {
  constructor() {
    super('This account has no claude.ai plan, so there are no usage limits to show.');
    this.name = 'NoPlanError';
  }
}

function looksLikeHtml(text) {
  return typeof text === 'string' && text.trimStart().startsWith('<');
}

/** GET a claude.ai endpoint with the browser's claude.ai cookies. Never throws on network errors. */
async function apiGet(path) {
  try {
    const res = await fetch(BASE + path, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: String(err) };
  }
}

function classify(res) {
  if (res.status === 200) {
    try {
      return JSON.parse(res.text);
    } catch {
      throw new BlockedError();
    }
  }
  if (res.status === 401 || res.status === 403) {
    if (looksLikeHtml(res.text)) throw new BlockedError();
    throw new AuthError();
  }
  if (res.status === 0) throw new Error("Couldn't reach claude.ai. Check your connection; this will try again.");
  throw new Error(`claude.ai answered with HTTP ${res.status}. This will try again.`);
}

// Cached for as long as the worker lives, so a popup opening twice doesn't refetch the list.
let orgCache = null;
let orgCacheAt = 0;

async function listOrgs() {
  const orgs = classify(await apiGet('/api/organizations'));
  if (!Array.isArray(orgs) || orgs.length === 0) throw new AuthError();
  orgCache = orgs
    .filter((o) => o && o.uuid)
    .map((o) => ({
      uuid: o.uuid,
      name: o.name || 'Organization',
      capabilities: Array.isArray(o.capabilities) ? o.capabilities : [],
    }));
  orgCacheAt = Date.now();
  return orgCache;
}

/**
 * pinnedId is the organization the user picked, or null. Returns either
 *   { needsChoice: true, orgs }   several organizations and no valid pick, or
 *   { raw, org, orgs }            the usage response for the organization to show.
 */
async function fetchUsage(pinnedId, retried = false) {
  const stale = !orgCache || Date.now() - orgCacheAt > ORG_LIST_TTL_MS;
  const all = stale ? await listOrgs() : orgCache;
  const orgs = core.chatOrgs(all);
  const decision = core.resolveOrg({ orgs: all, pinnedId });

  if (decision.type === 'none') throw new NoPlanError();
  if (decision.type === 'choose') return { needsChoice: true, orgs };

  const res = await apiGet(`/api/organizations/${encodeURIComponent(decision.uuid)}/usage`);
  if ([401, 403, 404].includes(res.status) && !looksLikeHtml(res.text) && !retried) {
    // The user may have left this organization. Reload the list once and decide again.
    orgCache = null;
    return fetchUsage(pinnedId, true);
  }
  return { raw: classify(res), org: orgs.find((o) => o.uuid === decision.uuid), orgs };
}

/* ---------- Refreshing ---------- */

let inFlight = null;

async function runRefresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await setState({ status: 'loading' });
    const settings = await loadSettings();
    try {
      const result = await fetchUsage(settings.orgId);
      if (result.needsChoice) {
        await setState({
          status: 'choose-org',
          limits: [],
          fetchedAt: null,
          message: null,
          org: null,
          orgCount: result.orgs.length,
          orgChoices: result.orgs.map((o) => ({ uuid: o.uuid, name: o.name })),
          orgs: result.orgs.map((o) => ({ uuid: o.uuid, name: o.name })),
        });
      } else {
        await setState({
          status: 'ok',
          limits: core.parseUsage(result.raw),
          fetchedAt: Date.now(),
          message: null,
          org: result.org ? { uuid: result.org.uuid, name: result.org.name } : null,
          orgCount: result.orgs.length,
          orgChoices: [],
          orgs: result.orgs.map((o) => ({ uuid: o.uuid, name: o.name })),
        });
      }
    } catch (err) {
      if (err instanceof AuthError) {
        await setState({
          status: 'auth',
          limits: [],
          fetchedAt: null,
          message: err.message,
          org: null,
          orgCount: 0,
          orgChoices: [],
          orgs: [],
        });
      } else if (err instanceof NoPlanError) {
        await setState({
          status: 'error',
          limits: [],
          fetchedAt: null,
          message: err.message,
          org: null,
          orgCount: 0,
          orgChoices: [],
          orgs: [],
        });
      } else {
        await setState({ status: 'error', message: (err && err.message) || String(err) });
      }
    } finally {
      await scheduleNext();
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Restarts the countdown, so the next automatic refresh is a full interval from now. */
async function scheduleNext() {
  const settings = await loadSettings();
  await chrome.alarms.create(ALARM, { periodInMinutes: settings.refreshMinutes });
  const alarm = await chrome.alarms.get(ALARM);
  await setState({ nextRefreshAt: alarm ? alarm.scheduledTime : null });
}

/** Refreshes only if the cached usage is older than one interval. Used when the popup opens. */
async function refreshIfStale() {
  const [state, settings] = await Promise.all([loadState(), loadSettings()]);
  const age = state.fetchedAt ? Date.now() - state.fetchedAt : Infinity;
  if (age > settings.refreshMinutes * 60 * 1000) await runRefresh();
  else await scheduleNext();
}

/* ---------- Messages from the popup and the options page ---------- */

const handlers = {
  async get() {
    const [state, settings] = await Promise.all([loadState(), loadSettings()]);
    return { state, settings };
  },

  async refresh() {
    await runRefresh();
    return handlers.get();
  },

  async setSetting({ key, value }) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return handlers.get();
    const settings = cleanSettings({ ...(await loadSettings()), [key]: value });
    await saveSettings(settings);
    if (key === 'refreshMinutes') await scheduleNext();
    if (key === 'orgId') {
      orgCache = null;
      await runRefresh();
    }
    const payload = await handlers.get();
    chrome.runtime.sendMessage({ type: 'state', ...payload }).catch(() => {});
    await paintBadge(payload.state, payload.settings);
    return payload;
  },

  async chooseOrg({ uuid }) {
    return handlers.setSetting({ key: 'orgId', value: String(uuid) });
  },

  async openClaude() {
    await chrome.tabs.create({ url: BASE });
    return { ok: true };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },

  async popupOpened() {
    // Answer with what we already have; a stale refresh runs behind the popup and pushes an update.
    const payload = await handlers.get();
    refreshIfStale();
    return payload;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  handler(message).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
  return true; // answer asynchronously
});

/* ---------- Lifecycle ---------- */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runRefresh();
});

chrome.runtime.onInstalled.addListener(() => runRefresh());
chrome.runtime.onStartup.addListener(() => runRefresh());
