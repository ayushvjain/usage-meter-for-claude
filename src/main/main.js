'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage } = require('electron');
const { RefreshScheduler, parseUsage, clampRefreshMinutes } = require('../shared/core');
const config = require('./config');
const { ClaudeClient, AuthError, NoPlanError } = require('./claude');

const WIDGET_WIDTH = 320;
const DEFAULT_HEIGHT = 260;
const EDGE_MARGIN = 16;
const REFRESH_CHOICES = [1, 2, 5, 10, 15, 30];
const REPO_URL = 'https://github.com/ayushvjain/usage-meter-for-claude';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

const client = new ClaudeClient();
let settings = null;
let widget = null;
let tray = null;
let scheduler = null;
let state = { status: 'loading', limits: [], fetchedAt: null, nextRefreshAt: null, message: null, org: null, orgCount: 0, orgChoices: [] };
let knownOrgs = [];

/* ---------- State ---------- */

function publicSettings() {
  return {
    showPeakHours: settings.showPeakHours,
    warnAt: settings.warnAt,
    dangerAt: settings.dangerAt,
    refreshMinutes: settings.refreshMinutes,
  };
}

function sendState() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('state', { ...state, settings: publicSettings() });
}

function setState(patch) {
  const wasAuth = state.status === 'auth';
  state = { ...state, ...patch };
  sendState();
  if (tray && wasAuth !== (state.status === 'auth')) tray.setContextMenu(buildMenu());
}

function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  config.save(settings);
  if (tray) tray.setContextMenu(buildMenu());
  sendState();
}

async function runRefresh() {
  setState({ status: 'loading' });
  try {
    const result = await client.fetchUsage({ pinnedId: settings.orgId });
    const orgsChanged = result.orgs.map((o) => o.uuid).join() !== knownOrgs.map((o) => o.uuid).join();
    knownOrgs = result.orgs;
    if (result.needsChoice) {
      setState({
        status: 'choose-org',
        limits: [],
        fetchedAt: null,
        message: null,
        org: null,
        orgCount: result.orgs.length,
        orgChoices: result.orgs.map((o) => ({ uuid: o.uuid, name: o.name, active: o.uuid === result.activeId })),
      });
    } else {
      setState({
        status: 'ok',
        limits: parseUsage(result.raw),
        fetchedAt: Date.now(),
        message: null,
        org: { uuid: result.org.uuid, name: result.org.name },
        orgCount: result.orgs.length,
        orgChoices: [],
      });
    }
    if (orgsChanged && tray) tray.setContextMenu(buildMenu());
  } catch (err) {
    if (err instanceof AuthError) {
      knownOrgs = [];
      setState({ status: 'auth', limits: [], fetchedAt: null, message: err.message, org: null, orgCount: 0, orgChoices: [] });
    } else if (err instanceof NoPlanError) {
      setState({ status: 'error', limits: [], fetchedAt: null, message: err.message, org: null, orgCount: 0, orgChoices: [] });
    } else {
      setState({ status: 'error', message: (err && err.message) || String(err) });
    }
  }
}

function chooseOrg(uuid) {
  if (!knownOrgs.some((o) => o.uuid === uuid)) return;
  updateSetting('orgId', uuid);
  scheduler.refreshNow('organization');
}

/* ---------- Theme ---------- */

function userThemePath() {
  return path.join(app.getPath('userData'), 'theme.css');
}

function ensureUserTheme() {
  const file = userThemePath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'theme-template.css'), file);
  }
}

function sendTheme() {
  if (!widget || widget.isDestroyed()) return;
  let css = '';
  try {
    css = fs.readFileSync(userThemePath(), 'utf8');
  } catch {
    css = '';
  }
  widget.webContents.send('theme', css);
}

function watchUserTheme() {
  // watchFile polls, which survives editors that save by replacing the file.
  fs.watchFile(userThemePath(), { interval: 1000 }, () => sendTheme());
}

/* ---------- Widget window ---------- */

function pointIsVisible(x, y) {
  return screen.getAllDisplays().some(({ workArea: a }) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height);
}

function initialPosition() {
  if (settings.position && pointIsVisible(settings.position.x + 20, settings.position.y + 20)) return settings.position;
  const { workArea: a } = screen.getPrimaryDisplay();
  return { x: a.x + a.width - WIDGET_WIDTH - EDGE_MARGIN, y: a.y + a.height - DEFAULT_HEIGHT - EDGE_MARGIN };
}

function createWidget() {
  const { x, y } = initialPosition();
  widget = new BrowserWindow({
    x,
    y,
    width: WIDGET_WIDTH,
    height: DEFAULT_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    title: 'Usage Meter for Claude',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widget.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  widget.once('ready-to-show', () => widget.show());

  let saveTimer = null;
  widget.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!widget || widget.isDestroyed()) return;
      const b = widget.getBounds();
      updateSetting('position', { x: b.x, y: b.y });
    }, 400);
  });

  widget.on('closed', () => {
    widget = null;
  });

  // Links inside the widget (if a theme adds any) open in the default browser.
  widget.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWidget() {
  if (!widget) createWidget();
  widget.show();
  widget.focus();
}

function toggleWidget() {
  if (widget && widget.isVisible()) widget.hide();
  else showWidget();
  if (tray) tray.setContextMenu(buildMenu());
}

/* ---------- Tray and menu ---------- */

function signIn() {
  client.openWindow({ autoClose: true, onSignedIn: () => scheduler.refreshNow('sign-in') });
}

function organizationMenu() {
  // Only accounts with more than one claude.ai organization get this menu.
  if (knownOrgs.length < 2) return [];
  return [
    {
      label: 'Organization',
      submenu: knownOrgs.map((o) => ({
        label: o.name,
        type: 'radio',
        checked: settings.orgId === o.uuid,
        click: () => chooseOrg(o.uuid),
      })),
    },
  ];
}

function buildMenu() {
  const storeBuild = Boolean(process.windowsStore);
  return Menu.buildFromTemplate([
    { label: widget && widget.isVisible() ? 'Hide widget' : 'Show widget', click: toggleWidget },
    { label: 'Refresh now', click: () => scheduler.refreshNow('manual') },
    { type: 'separator' },
    ...organizationMenu(),
    {
      label: 'Refresh every',
      submenu: REFRESH_CHOICES.map((minutes) => ({
        label: minutes === 1 ? '1 minute' : `${minutes} minutes`,
        type: 'radio',
        checked: settings.refreshMinutes === minutes,
        click: () => {
          updateSetting('refreshMinutes', clampRefreshMinutes(minutes));
          scheduler.setIntervalMs(settings.refreshMinutes * 60 * 1000);
        },
      })),
    },
    {
      label: 'Show peak hours',
      type: 'checkbox',
      checked: settings.showPeakHours,
      click: (item) => updateSetting('showPeakHours', item.checked),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => {
        updateSetting('alwaysOnTop', item.checked);
        if (widget) widget.setAlwaysOnTop(item.checked);
      },
    },
    {
      // Store (MSIX) builds manage startup through Windows Settings > Apps > Startup instead.
      label: storeBuild ? 'Start with Windows (set in Windows Settings)' : 'Start with Windows',
      type: 'checkbox',
      enabled: !storeBuild,
      checked: settings.startWithWindows,
      click: (item) => {
        updateSetting('startWithWindows', item.checked);
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: 'Edit theme…', click: () => shell.openPath(userThemePath()) },
    { label: 'Reset widget position', click: resetPosition },
    { type: 'separator' },
    { label: 'Open claude.ai', click: () => client.openWindow({ autoClose: false, onSignedIn: () => scheduler.refreshNow('sign-in') }) },
    state.status === 'auth' ? { label: 'Sign in…', click: signIn } : { label: 'Sign out', click: signOut },
    { label: 'About and source code', click: () => shell.openExternal(REPO_URL) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function resetPosition() {
  updateSetting('position', null);
  if (!widget) return;
  const { workArea: a } = screen.getPrimaryDisplay();
  const b = widget.getBounds();
  widget.setBounds({ x: a.x + a.width - WIDGET_WIDTH - EDGE_MARGIN, y: a.y + a.height - b.height - EDGE_MARGIN, width: WIDGET_WIDTH, height: b.height });
}

async function signOut() {
  await client.signOut();
  knownOrgs = [];
  updateSetting('orgId', null);
  setState({ status: 'auth', limits: [], fetchedAt: null, message: null, org: null, orgCount: 0, orgChoices: [] });
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Usage Meter for Claude');
  tray.setContextMenu(buildMenu());
  tray.on('click', toggleWidget);
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('usage:refresh', () => scheduler.refreshNow('manual'));
  ipcMain.handle('auth:sign-in', () => signIn());
  ipcMain.handle('org:choose', (_event, uuid) => chooseOrg(String(uuid)));

  ipcMain.on('widget:ready', () => {
    sendTheme();
    sendState();
  });

  ipcMain.on('widget:menu', () => {
    if (widget) buildMenu().popup({ window: widget });
  });

  ipcMain.on('widget:resize', (_event, requested) => {
    if (!widget || widget.isDestroyed()) return;
    const height = Math.max(80, Math.min(900, Math.round(Number(requested) || DEFAULT_HEIGHT)));
    const b = widget.getBounds();
    if (b.height === height) return;
    const { workArea: a } = screen.getDisplayMatching(b);
    const wasTouchingBottom = b.y + b.height >= a.y + a.height - EDGE_MARGIN - 2;
    let y = b.y;
    // Keep a widget docked near the bottom edge anchored there as it grows or shrinks.
    if (wasTouchingBottom || y + height > a.y + a.height) y = Math.max(a.y, a.y + a.height - height - EDGE_MARGIN);
    widget.setBounds({ x: b.x, y, width: WIDGET_WIDTH, height });
  });
}

/* ---------- App lifecycle ---------- */

async function start() {
  settings = config.load();
  ensureUserTheme();
  client.init();
  registerIpc();
  createWidget();
  createTray();
  watchUserTheme();

  if (!process.windowsStore && settings.startWithWindows) app.setLoginItemSettings({ openAtLogin: true });

  scheduler = new RefreshScheduler({
    intervalMs: settings.refreshMinutes * 60 * 1000,
    task: runRefresh,
    onScheduled: (nextAt) => {
      setState({ nextRefreshAt: nextAt });
      if (tray) tray.setContextMenu(buildMenu());
    },
  });
  scheduler.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWidget);
  app.whenReady().then(start);
  // Keep running in the tray when every window is closed.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    if (scheduler) scheduler.stop();
    fs.unwatchFile(userThemePath());
  });
}
