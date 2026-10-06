'use strict';

/*
 * The few Windows functions the widget needs, loaded once from user32.dll through koffi
 * (a prebuilt FFI library, nothing to compile). Returns null on other platforms or if
 * loading fails, so callers can fall back to plain Electron behaviour.
 */

let cached;

function load() {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'win32') return cached;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const fn = (proto) => user32.func(proto);
    const optional = (proto) => {
      try {
        return fn(proto);
      } catch {
        return null;
      }
    };
    cached = {
      GetForegroundWindow: fn('intptr_t __stdcall GetForegroundWindow()'),
      GetWindow: fn('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)'),
      FindWindowW: fn('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      FindWindowExW: fn('intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)'),
      GetClassNameW: fn('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
      SetWindowPos: fn('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
      SendMessageTimeoutW: fn(
        'intptr_t __stdcall SendMessageTimeoutW(intptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t fuFlags, uint32_t uTimeout, _Out_ uintptr_t *lpdwResult)',
      ),
      // 64-bit Windows exports SetWindowLongPtrW; 32-bit only has SetWindowLongW.
      SetWindowLongPtrW:
        optional('intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)') ||
        optional('long __stdcall SetWindowLongW(intptr_t hWnd, int nIndex, long dwNewLong)'),
      SystemParametersInfoForDpi: optional(
        'bool __stdcall SystemParametersInfoForDpi(uint32_t uiAction, uint32_t uiParam, _Out_ int *pvParam, uint32_t fWinIni, uint32_t dpi)',
      ),
    };
  } catch (err) {
    console.warn('Windows desktop features unavailable:', err && err.message);
    cached = null;
  }
  return cached;
}

/** Window handle of an Electron BrowserWindow as a number. */
function handleOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

/** Window class name, or '' when the handle is 0 or gone. */
function classNameOf(api, hwnd) {
  if (!hwnd) return '';
  const buf = Buffer.alloc(512);
  const n = api.GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

module.exports = { load, handleOf, classNameOf };