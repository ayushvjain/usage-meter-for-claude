'use strict';

/*
 * Keeps the widget on the Windows desktop: above the wallpaper and icons, below every app
 * window, the way desktop widgets and gadgets behave. App windows cover it; Win+D (Show
 * desktop) reveals it.
 *
 * Electron has no setting for this, so the module calls three Windows functions from
 * user32.dll through koffi (a prebuilt FFI library, nothing to compile):
 *   GetForegroundWindow   which window has focus
 *   GetWindow / GetClassNameW / FindWindowW   read the window stack
 *   SetWindowPos          move the widget in the stack without moving or focusing it
 *
 * The decision itself lives in planDesktopPlacement (src/shared/core.js) and is unit tested.
 * Set USAGE_METER_DEBUG_DESKTOP=1 to log what the module sees.
 */

const { planDesktopPlacement } = require('../shared/core');

const TICK_MS = 400;
const GW_HWNDPREV = 3;
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

function loadUser32() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    return {
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)'),
      FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)',
      ),
    };
  } catch (err) {
    console.warn('Desktop layer unavailable, the widget will behave like a normal window:', err && err.message);
    return null;
  }
}

function handleOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

/** Pins `win` to the desktop layer. Returns { supported, detach }. */
function attach(win) {
  const api = loadUser32();
  if (!api) return { supported: false, detach() {} };

  const debug = process.env.USAGE_METER_DEBUG_DESKTOP === '1';
  const self = handleOf(win);
  const nameBuf = Buffer.alloc(512);
  const classOf = (h) => {
    if (!h) return '';
    const n = api.GetClassNameW(h, nameBuf, 256);
    return n > 0 ? nameBuf.toString('utf16le', 0, n * 2) : '';
  };
  const windowAbove = (h) => Number(api.GetWindow(h, GW_HWNDPREV)) || 0;

  let lastForeign = 0;
  let lastLog = '';

  function tick() {
    if (win.isDestroyed() || !win.isVisible()) return;
    try {
      const fg = Number(api.GetForegroundWindow()) || 0;
      const fgClass = classOf(fg);
      // Clicking the widget, the taskbar or a menu keeps the previous decision.
      if (fg && fg !== self && !NEUTRAL_CLASSES.has(fgClass)) lastForeign = fg;

      const progman = Number(api.FindWindowW('Progman', null)) || 0;
      const plan = planDesktopPlacement({ self, foreground: lastForeign, progman, classOf, windowAbove });
      if (plan.action === 'place') api.SetWindowPos(self, plan.insertAfter, 0, 0, 0, 0, FLAGS);

      if (debug) {
        const line = `foreground=${fgClass || '-'} decidingWindow=${classOf(lastForeign) || '-'} action=${plan.action}`;
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