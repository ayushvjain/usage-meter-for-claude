'use strict';

/*
 * Keeps the widget on the Windows desktop: above the wallpaper and icons, below every app
 * window, the way desktop widgets and gadgets behave. App windows cover it; Win+D (Show
 * desktop) reveals it.
 *
 * Two things work together:
 *
 * 1. The widget is "owned" by the desktop window (Progman). Windows always keeps an owned
 *    window above its owner, so clicking the desktop can never cover the widget, not even
 *    for a moment.
 * 2. When something does lift the widget above apps (clicking it, for example), it is put
 *    back directly above the desktop. That decision is planDesktopPlacement in
 *    src/shared/core.js, which is unit tested.
 *
 * Set USAGE_METER_DEBUG_DESKTOP=1 to log what the module sees.
 */

const { planDesktopPlacement } = require('../../../shared/core');
const win32 = require('./win32');

const TICK_MS = 250;
const GW_OWNER = 4;
const GW_HWNDPREV = 3;
const GWLP_HWNDPARENT = -8;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;

// Focusing these doesn't change where the widget should be (taskbar, tray, menus, Start).
const NEUTRAL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow',
  'Windows.UI.Core.CoreWindow',
  '#32768',
]);

/** Pins `win` to the desktop layer. Returns { supported, detach }. */
function attach(win) {
  const api = win32.load();
  if (!api) return { supported: false, detach() {} };

  const debug = process.env.USAGE_METER_DEBUG_DESKTOP === '1';
  const self = win32.handleOf(win);
  const classOf = (h) => win32.classNameOf(api, h);
  const windowAbove = (h) => Number(api.GetWindow(h, GW_HWNDPREV)) || 0;

  let lastForeign = 0;
  let lastLog = '';

  function ensureOwnedByDesktop(progman) {
    if (!progman || !api.SetWindowLongPtrW) return;
    const owner = Number(api.GetWindow(self, GW_OWNER)) || 0;
    // Progman changes when Explorer restarts, so this is checked on every tick.
    if (owner !== progman) api.SetWindowLongPtrW(self, GWLP_HWNDPARENT, progman);
  }

  function tick() {
    if (win.isDestroyed() || !win.isVisible()) return;
    try {
      const progman = Number(api.FindWindowW('Progman', null)) || 0;
      ensureOwnedByDesktop(progman);

      const fg = Number(api.GetForegroundWindow()) || 0;
      const fgClass = classOf(fg);
      // Clicking the widget, the taskbar or a menu keeps the previous decision.
      if (fg && fg !== self && !NEUTRAL_CLASSES.has(fgClass)) lastForeign = fg;

      const plan = planDesktopPlacement({ self, foreground: lastForeign, progman, classOf, windowAbove });
      if (plan.action === 'place') api.SetWindowPos(self, plan.insertAfter, 0, 0, 0, 0, FLAGS);

      if (debug) {
        const owned = (Number(api.GetWindow(self, GW_OWNER)) || 0) === progman;
        const line = `foreground=${fgClass || '-'} decidingWindow=${classOf(lastForeign) || '-'} ownedByDesktop=${owned} action=${plan.action}`;
        if (line !== lastLog) console.log('[desktop-layer]', line);
        lastLog = line;
      }
    } catch (err) {
      if (debug) console.warn('[desktop-layer] tick failed:', err && err.message);
    }
  }

  win.on('focus', tick);
  win.on('show', tick);
  const timer = setInterval(tick, TICK_MS);
  tick();

  return {
    supported: true,
    detach() {
      clearInterval(timer);
      if (!win.isDestroyed()) {
        win.removeListener('focus', tick);
        win.removeListener('show', tick);
      }
    },
  };
}

module.exports = { attach };
