'use strict';

/*
 * The size of one desktop icon tile, so the widget can snap to the same grid as your icons.
 *
 * In order of preference:
 * 1. Ask the desktop's icon view directly (LVM_GETITEMSPACING). This matches what you see,
 *    including your icon size (View > Small, Medium or Large icons).
 * 2. Windows' icon spacing setting (SystemParametersInfoForDpi).
 * 3. A sensible default of 75 x 75.
 */

const { decodeItemSpacing, FALLBACK_CELL } = require('../shared/core');
const win32 = require('./win32');

const LVM_GETITEMSPACING = 0x1000 + 51;
const SMTO_ABORTIFHUNG = 0x0002;
const SPI_ICONHORIZONTALSPACING = 0x000d;
const SPI_ICONVERTICALSPACING = 0x0018;

function findDesktopListView(api) {
  const inDefView = (parent) => {
    const defView = Number(api.FindWindowExW(parent, 0, 'SHELLDLL_DefView', null)) || 0;
    return defView ? Number(api.FindWindowExW(defView, 0, 'SysListView32', null)) || 0 : 0;
  };
  const progman = Number(api.FindWindowW('Progman', null)) || 0;
  let lv = progman ? inDefView(progman) : 0;
  // When a wallpaper app or slideshow is active, the icons live in a WorkerW window instead.
  let worker = 0;
  for (let i = 0; !lv && i < 32; i += 1) {
    worker = Number(api.FindWindowExW(0, worker, 'WorkerW', null)) || 0;
    if (!worker) break;
    lv = inDefView(worker);
  }
  return lv;
}

function fromListView(api, scaleFactor) {
  const lv = findDesktopListView(api);
  if (!lv) return null;
  const out = [0];
  const ok = Number(api.SendMessageTimeoutW(lv, LVM_GETITEMSPACING, 0, 0, SMTO_ABORTIFHUNG, 200, out));
  if (!ok) return null;
  return decodeItemSpacing(out[0], scaleFactor);
}

function fromSystemSettings(api) {
  if (!api.SystemParametersInfoForDpi) return null;
  const w = [0];
  const h = [0];
  // 96 DPI returns device-independent pixels, which is what Electron positions windows in.
  const okW = api.SystemParametersInfoForDpi(SPI_ICONHORIZONTALSPACING, 0, w, 0, 96);
  const okH = api.SystemParametersInfoForDpi(SPI_ICONVERTICALSPACING, 0, h, 0, 96);
  if (!okW || !okH || w[0] < 32 || h[0] < 32) return null;
  return { w: w[0], h: h[0] };
}

/** One tile in device-independent pixels: { w, h, source }. */
function getCell(screen) {
  const api = win32.load();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  if (api) {
    try {
      const listView = fromListView(api, scale);
      if (listView) return { ...listView, source: 'desktop icons' };
      const system = fromSystemSettings(api);
      if (system) return { ...system, source: 'Windows icon spacing' };
    } catch (err) {
      console.warn('Could not read the desktop icon grid:', err && err.message);
    }
  }
  return { ...FALLBACK_CELL, source: 'default' };
}

module.exports = { getCell };