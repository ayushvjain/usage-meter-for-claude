'use strict';

/*
 * Keeps the widget on the macOS desktop: just above the desktop icons and below every app
 * window, on every Space, and left in place by Mission Control.
 *
 * Electron's own `type: 'desktop'` window sits at the desktop level too, but such windows
 * receive no clicks, so the widget's buttons wouldn't work. Instead this sets the window
 * level directly, the way desktop-widget apps do:
 *
 *   level              CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1
 *   collectionBehavior canJoinAllSpaces | stationary | ignoresCycle
 *
 * The calls go to the Objective-C runtime through koffi (prebuilt, nothing to compile).
 * Set USAGE_METER_DEBUG_DESKTOP=1 to log the level that was applied.
 */

const CHECK_MS = 2000;
const kCGDesktopIconWindowLevelKey = 18;
const NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0;
const NSWindowCollectionBehaviorStationary = 1 << 4;
const NSWindowCollectionBehaviorIgnoresCycle = 1 << 6;
const BEHAVIOR =
  NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;

let cached;

function loadRuntime() {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'darwin') return cached;
  try {
    const koffi = require('koffi');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    // objc_msgSend must be declared once per call shape; it is never called as variadic.
    cached = {
      koffi,
      sel: objc.func('void *sel_registerName(const char *name)'),
      sendForPointer: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
      sendForLong: objc.func('objc_msgSend', 'long', ['void *', 'void *']),
      sendWithLong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']),
      sendWithULong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'unsigned long']),
      levelForKey: cg.func('int32_t CGWindowLevelForKey(int32_t key)'),
    };
  } catch (err) {
    console.warn('macOS desktop features unavailable:', err && err.message);
    cached = null;
  }
  return cached;
}

/** Pins `win` to the desktop layer. Returns { supported, detach }. */
function attach(win) {
  const rt = loadRuntime();
  if (!rt) return { supported: false, detach() {} };

  const debug = process.env.USAGE_METER_DEBUG_DESKTOP === '1';
  let nsWindow = null;
  let target = 0;

  function resolveWindow() {
    // getNativeWindowHandle() holds an NSView pointer; its window is the NSWindow.
    const view = rt.koffi.decode(win.getNativeWindowHandle(), 'void *');
    nsWindow = rt.sendForPointer(view, rt.sel('window'));
    target = rt.levelForKey(kCGDesktopIconWindowLevelKey) + 1;
  }

  function currentLevel() {
    return Number(rt.sendForLong(nsWindow, rt.sel('level')));
  }

  function apply(reason) {
    if (win.isDestroyed()) return;
    try {
      if (!nsWindow) resolveWindow();
      if (currentLevel() !== target) {
        rt.sendWithLong(nsWindow, rt.sel('setLevel:'), target);
        rt.sendWithULong(nsWindow, rt.sel('setCollectionBehavior:'), BEHAVIOR);
      }
      if (debug) {
        const level = currentLevel();
        console.log(`[desktop-layer] pinned reason=${reason} level=${level} expected=${target} ${level === target ? 'ok' : 'mismatch'}`);
      }
    } catch (err) {
      if (debug) console.warn('[desktop-layer] could not set the window level:', err && err.message);
    }
  }

  const onShow = () => apply('show');
  win.on('show', onShow);
  // Re-check now and then, in case something resets the level (for example a display change).
  const timer = setInterval(() => apply('check'), CHECK_MS);
  apply('attach');

  return {
    supported: true,
    detach() {
      clearInterval(timer);
      if (!win.isDestroyed()) win.removeListener('show', onShow);
    },
  };
}

module.exports = { attach };
