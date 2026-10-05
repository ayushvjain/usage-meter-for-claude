'use strict';

/*
 * Talks to claude.ai the same way the claude.ai Usage page does.
 *
 * The user signs in once inside an embedded claude.ai window. The session is kept in a
 * persistent Electron partition. Requests are made from a hidden window whose page is on
 * the claude.ai origin, so cookies and browser checks behave like a normal browser tab.
 *
 * The endpoints are private and undocumented. If claude.ai changes them, only this file
 * should need updating.
 */

const { BrowserWindow, session } = require('electron');
const { resolveOrg, chatOrgs } = require('../shared/core');

const BASE = 'https://claude.ai';
const PARTITION = 'persist:claude';
const ORG_LIST_TTL_MS = 30 * 60 * 1000;
const SIGN_IN_PATHS = /^\/(login|logout|magic-link|oauth|auth|verify)/;

class AuthError extends Error {
  constructor(message) {
    super(message || 'Sign in to claude.ai to see your usage.');
    this.name = 'AuthError';
  }
}

class NoPlanError extends Error {
  constructor() {
    super('This account has no claude.ai plan, so there are no usage limits to show.');
    this.name = 'NoPlanError';
  }
}

class BlockedError extends Error {
  constructor(message) {
    super(message || 'claude.ai asked for a browser check. Choose "Open claude.ai" from the menu, then refresh.');
    this.name = 'BlockedError';
  }
}

function chromeUserAgent() {
  // A plain Chrome user agent, without the "Electron/x" token that some sign-in providers reject.
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function looksLikeHtml(text) {
  return typeof text === 'string' && text.trimStart().startsWith('<');
}

function isClaudeHost(hostname) {
  return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
}

const secureWebPreferences = () => ({
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

class ClaudeClient {
  constructor() {
    this.ses = null;
    this.bridge = null;
    this.bridgeReady = null;
    this.orgs = null;
    this.orgsFetchedAt = 0;
    this.loginWin = null;
  }

  init() {
    this.ses = session.fromPartition(PARTITION);
    this.ses.setUserAgent(chromeUserAgent());
  }

  /* ---------- Hidden same-origin bridge ---------- */

  ensureBridge() {
    if (this.bridge && !this.bridge.isDestroyed() && this.bridgeReady) return this.bridgeReady;
    this.bridge = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: secureWebPreferences() });
    this.bridge.on('closed', () => {
      this.bridge = null;
      this.bridgeReady = null;
    });
    // Before sign-in this URL answers with an error status. That is fine: all we need is a page on the claude.ai origin.
    this.bridgeReady = this.bridge.loadURL(`${BASE}/api/organizations`).catch(() => {});
    return this.bridgeReady;
  }

  resetBridge() {
    if (this.bridge && !this.bridge.isDestroyed()) this.bridge.destroy();
    this.bridge = null;
    this.bridgeReady = null;
  }

  async apiGet(apiPath) {
    await this.ensureBridge();
    if (!this.bridge.webContents.getURL().startsWith(BASE)) {
      // The last load failed (offline, for example). Try a fresh page once.
      this.resetBridge();
      await this.ensureBridge();
    }
    const url = JSON.stringify(BASE + apiPath);
    const script = `fetch(${url}, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((e) => ({ status: 0, text: String(e) }))`;
    return this.bridge.webContents.executeJavaScript(script, true);
  }

  classify(res) {
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
    if (res.status === 0) throw new Error("Couldn't reach claude.ai. Check your connection; the widget will try again.");
    throw new Error(`claude.ai answered with HTTP ${res.status}. The widget will try again.`);
  }

  /* ---------- Organization and usage ---------- */

  async listOrgs() {
    const orgs = this.classify(await this.apiGet('/api/organizations'));
    if (!Array.isArray(orgs) || orgs.length === 0) throw new AuthError();
    this.orgs = orgs
      .filter((o) => o && o.uuid)
      .map((o) => ({ uuid: o.uuid, name: o.name || 'Organization', capabilities: Array.isArray(o.capabilities) ? o.capabilities : [] }));
    this.orgsFetchedAt = Date.now();
    return this.orgs;
  }

  async activeOrgId() {
    // The organization currently selected on claude.ai. Only used to label it in the picker.
    const cookies = await this.ses.cookies.get({ url: BASE, name: 'lastActiveOrg' });
    return cookies[0] && cookies[0].value ? cookies[0].value : null;
  }

  async usageFor(orgId) {
    return this.apiGet(`/api/organizations/${encodeURIComponent(orgId)}/usage`);
  }

  /**
   * pinnedId is the organization the user picked, or null.
   * Returns one of:
   *   { needsChoice: true, orgs, activeId }   several organizations and no valid pick
   *   { raw, org, orgs }                      the usage response for the organization to show
   * orgs is always the list of claude.ai (chat) organizations.
   */
  async fetchUsage({ pinnedId = null } = {}, retried = false) {
    const stale = !this.orgs || Date.now() - this.orgsFetchedAt > ORG_LIST_TTL_MS;
    const all = stale ? await this.listOrgs() : this.orgs;
    const orgs = chatOrgs(all);
    const decision = resolveOrg({ orgs: all, pinnedId });

    if (decision.type === 'none') throw new NoPlanError();
    if (decision.type === 'choose') return { needsChoice: true, orgs, activeId: await this.activeOrgId() };

    const res = await this.usageFor(decision.uuid);
    if ([401, 403, 404].includes(res.status) && !looksLikeHtml(res.text) && !retried) {
      // The user may have left this organization. Reload the list once and decide again.
      this.orgs = null;
      return this.fetchUsage({ pinnedId }, true);
    }
    const raw = this.classify(res);
    return { raw, org: orgs.find((o) => o.uuid === decision.uuid), orgs };
  }

  async isSignedIn() {
    try {
      const res = await this.apiGet('/api/organizations');
      return res.status === 200 && !looksLikeHtml(res.text);
    } catch {
      return false;
    }
  }

  /* ---------- Sign in / out ---------- */

  /**
   * Opens claude.ai in a normal window. With autoClose, the window closes itself once the
   * user is signed in. onSignedIn runs once, the first time a signed-in session is seen.
   */
  openWindow({ autoClose = true, onSignedIn } = {}) {
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.show();
      this.loginWin.focus();
      return;
    }

    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Sign in to Claude',
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences(),
    });
    this.loginWin = win;

    // Sign-in providers (Google, for example) open popups. Keep them in the same session.
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences() },
    }));

    let timer = null;
    let reported = false;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (reported || win.isDestroyed()) return;
        let url;
        try {
          url = new URL(win.webContents.getURL());
        } catch {
          return;
        }
        if (!isClaudeHost(url.hostname) || SIGN_IN_PATHS.test(url.pathname)) return;
        if (!(await this.isSignedIn())) return;
        reported = true;
        this.orgs = null;
        if (onSignedIn) onSignedIn();
        if (autoClose && !win.isDestroyed()) win.close();
      }, 800);
    };

    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.webContents.on('did-finish-load', check);
    win.on('closed', () => {
      clearTimeout(timer);
      this.loginWin = null;
    });

    win.loadURL(autoClose ? `${BASE}/login` : BASE).catch(() => {});
  }

  async signOut() {
    if (this.loginWin && !this.loginWin.isDestroyed()) this.loginWin.close();
    await this.ses.clearStorageData();
    this.orgs = null;
    this.resetBridge();
  }
}

module.exports = { ClaudeClient, AuthError, BlockedError, NoPlanError };
