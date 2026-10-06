'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage, nativeTheme } = require('electron');
const { RefreshScheduler, parseUsage, gridLayout, snapToGrid, defaultTile, WIDGET_SIZES, ACCENTS, OPACITY_RANGE } = require('../shared/core');
const config = require('./config');
const { ClaudeClient, AuthError, NoPlanError } = require('./claude');
const desktopLayer = require('./desktop-layer');
const desktopGrid = require('./desktop-grid');

// Transparent margin around the panel inside the widget window. Must match --tile-inset in styles.css.
const TILE_INSET = 4;
const DEFAULT_CONTENT_HEIGHT = 300;
const REFRESH_CHOICES = [1, 2, 5, 10, 15, 30];
const REPO_URL = 'https://github.com/ayushvjain/usage-meter-for-claude';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');

const client = new ClaudeClient();
let settings = null;
let widget = null;
let settingsWin = null;
let desktopPin = null;
let tray = null;
let scheduler = null;
let quitting = false;
let cell = null;
let contentHeight = DEFAULT_CONTENT_HEIGHT;
let knownOrgs = [];
let state = {
  status: 'loading',
  limits: [],
  fetchedAt: null,
  nextRefreshAt: null,
  message: null,
  org: null,
  orgCount: 0,
  orgChoices: [],
  signInPending: false,
};

/* ---------- State ---------- */

function publicSettings() {
  return {
    showPeakHours: settings.showPeakHours,
    warnAt: settings.warnAt,
    dangerAt: settings.dangerAt,
    refreshMinutes: settings.refreshMinutes,
    theme: settings.theme,
    accent: settings.accent,
    opacity: settings.opacity,
  };
}

/** Everything the Settings window shows. */
function settingsSnapshot() {
  return {
    settings: {
      refreshMinutes: settings.refreshMinutes,
      showPeakHours: settings.showPeakHours,
      startWithWindows: settings.startWithWindows,
      theme: settings.theme,
      accent: settings.accent,
      opacity: settings.opacity,
      widgetSize: settings.widgetSize,
    },
    account: {
      status: state.status,
      signInPending: state.signInPending,
      org: state.org,
      chosenOrgId: settings.orgId,
      orgs: knownOrgs.map((o) => ({ uuid: o.uuid, name: o.name })),
    },
    options: {
      refreshChoices: REFRESH_CHOICES,
      accents: ACCENTS,
      sizes: Object.keys(WIDGET_SIZES),
      opacity: OPACITY_RANGE,
    },
    app: {
      version: app.getVersion(),
      storeBuild: Boolean(process.windowsStore),
      repoUrl: REPO_URL,
      grid: cell ? { w: cell.w, h: cell.h, source: cell.source } : null,
    },
  };
}

function sendState() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('state', { ...state, settings: publicSettings() });
}

function sendSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settingsSnapshot());
}

function setState(patch) {
  const wasAuth = state.status === 'auth';
  state = { ...state, ...patch };
  sendState();
  sendSettings();
  if (tray && wasAuth !== (state.status === 'auth')) tray.setContextMenu(buildMenu());
}

function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  config.save(settings);
  sendState();
  sendSettings();
}

/** A change made in the Settings window, plus whatever it affects right away. */
function applySetting(key, value) {
  const clean = config.cleanEditable(key, value);
  if (clean === undefined) return;
  updateSetting(key, clean);
  if (key === 'refreshMinutes') scheduler.setIntervalMs(clean * 60 * 1000);
  if (key === 'startWithWindows' && !process.windowsStore) app.setLoginItemSettings({ openAtLogin: clean });
  if (key === 'widgetSize') layoutWidget();
}

async function runRefresh() {
  setState({ status: 'loading' });
  try {
    const result = await client.fetchUsage({ pinnedId: settings.orgId });
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

/* ---------- Account ---------- */

function signIn() {
  setState({ signInPending: true });
  client.openWindow({
    autoClose: true,
    onSignedIn: () => scheduler.refreshNow('sign-in'),
    onShown: () => setState({ signInPending: false }),
    onClosed: () => setState({ signInPending: false }),
  });
}

function openClaude() {
  client.openWindow({ autoClose: false, onSignedIn: () => scheduler.refreshNow('sign-in') });
}

async function signOut() {
  await client.signOut();
  knownOrgs = [];
  updateSetting('orgId', null);
  setState({ status: 'auth', limits: [], fetchedAt: null, message: null, org: null, orgCount: 0, orgChoices: [] });
}

/* ---------- Custom CSS (for developers) ---------- */

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

/* ---------- Widget window and desktop grid ---------- */

function refreshCell() {
  cell = desktopGrid.getCell(screen);
}

function currentLayout() {
  return gridLayout({ cell, tilesWide: WIDGET_SIZES[settings.widgetSize], contentHeight, inset: TILE_INSET });
}

function areaFor(point) {
  return screen.getDisplayNearestPoint(point).workArea;
}

/** Where the widget's top-left tile should be for a window of the given size. */
function tileFor(size) {
  const saved = settings.position;
  if (saved) {
    const area = areaFor({ x: saved.x + 10, y: saved.y + 10 });
    return snapToGrid({ ...saved, ...size }, area, cell);
  }
  return defaultTile(size, screen.getPrimaryDisplay().workArea, cell);
}

/** Sizes the widget to whole tiles and puts it on the nearest tile. */
function layoutWidget() {
  if (!widget || widget.isDestroyed()) return;
  const { width, height } = currentLayout();
  const { x, y } = tileFor({ width, height });
  const b = widget.getBounds();
  if (b.x !== x || b.y !== y || b.width !== width || b.height !== height) widget.setBounds({ x, y, width, height });
}

/** After the user drags the widget, snap it to the nearest tile and remember it. */
function snapAfterMove() {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const snapped = snapToGrid(b, areaFor({ x: b.x + b.width / 2, y: b.y + b.height / 2 }), cell);
  if (snapped.x !== b.x || snapped.y !== b.y) widget.setBounds({ x: snapped.x, y: snapped.y, width: b.width, height: b.height });
  if (!settings.position || settings.position.x !== snapped.x || settings.position.y !== snapped.y) {
    updateSetting('position', { x: snapped.x, y: snapped.y });
  }
}

function createWidget() {
  const { width, height } = currentLayout();
  const { x, y } = tileFor({ width, height });
  widget = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // "toolbar" makes it a tool window: no taskbar button and not listed in Alt+Tab.
    type: 'toolbar',
    // A desktop widget sits below app windows; desktop-layer.js keeps it there.
    alwaysOnTop: false,
    show: false,
    title: 'Usage Meter for Claude',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widget.loadFile(path.join(RENDERER, 'index.html'));
  widget.once('ready-to-show', () => {
    widget.showInactive();
    desktopPin = desktopLayer.attach(widget);
  });

  let moveTimer = null;
  widget.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(snapAfterMove, 120);
  });

  widget.on('closed', () => {
    clearTimeout(moveTimer);
    if (desktopPin) desktopPin.detach();
    desktopPin = null;
    widget = null;
    // The widget belongs to the desktop window, so Windows closes it if Explorer restarts.
    // Bring it back unless the app is quitting.
    if (!quitting) setTimeout(() => !widget && !quitting && createWidget(), 1500);
  });

  // Links inside the widget (if a theme adds any) open in the default browser.
  widget.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWidget() {
  if (!widget) {
    createWidget();
    return;
  }
  // Show without focusing, so the widget stays on the desktop instead of jumping over apps.
  widget.showInactive();
}

function toggleWidget() {
  if (widget && widget.isVisible()) widget.hide();
  else showWidget();
  if (tray) tray.setContextMenu(buildMenu());
}

function resetPosition() {
  updateSetting('position', null);
  layoutWidget();
}

/* ---------- Settings window ---------- */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Settings · Usage Meter for Claude',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131b29' : '#f4f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------- Tray and menu ---------- */

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Refresh now', click: () => scheduler.refreshNow('manual') },
    { label: 'Settings…', click: openSettings },
    ...(state.status === 'auth' ? [{ label: 'Sign in…', click: signIn }] : []),
    { type: 'separator' },
    { label: widget && widget.isVisible() ? 'Hide widget' : 'Show widget', click: toggleWidget },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Usage Meter for Claude');
  tray.setContextMenu(buildMenu());
  tray.on('click', toggleWidget);
}

/* ---------- IPC ---------- */

const ACTIONS = {
  'open-theme-file': () => shell.openPath(userThemePath()),
  'reset-position': resetPosition,
  'open-repo': () => shell.openExternal(REPO_URL),
  'open-claude': openClaude,
  'open-settings': openSettings,
};

function registerIpc() {
  ipcMain.handle('usage:refresh', () => scheduler.refreshNow('manual'));
  ipcMain.handle('auth:sign-in', () => signIn());
  ipcMain.handle('auth:sign-out', () => signOut());
  ipcMain.handle('org:choose', (_event, uuid) => chooseOrg(String(uuid)));
  ipcMain.handle('settings:get', () => settingsSnapshot());
  ipcMain.handle('settings:set', (_event, key, value) => applySetting(String(key), value));
  ipcMain.handle('app:action', (_event, name) => {
    const action = ACTIONS[String(name)];
    if (action) action();
  });

  ipcMain.on('widget:ready', () => {
    sendTheme();
    sendState();
  });

  ipcMain.on('widget:menu', () => {
    if (widget) buildMenu().popup({ window: widget });
  });

  // The widget reports how tall its content is; the window becomes that many whole tiles.
  ipcMain.on('widget:resize', (_event, requested) => {
    const h = Math.round(Number(requested));
    if (!Number.isFinite(h) || h <= 0 || h > 2000 || h === contentHeight) return;
    contentHeight = h;
    layoutWidget();
  });
}

/* ---------- App lifecycle ---------- */

async function start() {
  settings = config.load();
  refreshCell();
  ensureUserTheme();
  client.init();
  registerIpc();
  createWidget();
  createTray();
  watchUserTheme();

  // The icon grid changes with display scaling, resolution and desktop icon size.
  const onDisplayChange = () => {
    refreshCell();
    layoutWidget();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  if (!process.windowsStore && settings.startWithWindows) app.setLoginItemSettings({ openAtLogin: true });

  scheduler = new RefreshScheduler({
    intervalMs: settings.refreshMinutes * 60 * 1000,
    task: runRefresh,
    onScheduled: (nextAt) => setState({ nextRefreshAt: nextAt }),
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
    quitting = true;
    if (scheduler) scheduler.stop();
    fs.unwatchFile(userThemePath());
  });
}