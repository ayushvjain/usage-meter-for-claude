'use strict';

/*
 * The other half of the page reader. claude-page.js runs in the page's world, where it can
 * wrap fetch but cannot talk to the extension; this runs beside it in the extension's world,
 * where it can. All it does is carry usage numbers across that line.
 *
 * Everything arriving here comes from a web page, so it is checked before it is passed on:
 * same window, same origin, our own tag, and a plain object of windows.
 */

(() => {
  const WINDOW_KEYS = ['5h', '7d'];

  function clean(windows) {
    if (!windows || typeof windows !== 'object') return null;
    const out = {};
    for (const key of WINDOW_KEYS) {
      const win = windows[key];
      if (!win || typeof win !== 'object') continue;
      if (typeof win.utilization !== 'number') continue;
      out[key] = {
        utilization: win.utilization,
        resets_at: typeof win.resets_at === 'number' ? win.resets_at : null,
        status: typeof win.status === 'string' ? win.status : null,
      };
    }
    return Object.keys(out).length ? out : null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'usage-meter-reader') return;
    // A chat request the reader noticed, with or without usage in it. Counted so Settings
    // can say whether the reader is seeing anything at all.
    if (data.sawChat === 'completion' || data.sawChat === 'timeline') {
      chrome.runtime.sendMessage({ type: 'sawChat', kind: data.sawChat }).catch(() => {});
      return;
    }
    const windows = clean(data.windows);
    if (!windows) return;
    const orgId = typeof data.orgId === 'string' && /^[0-9a-f-]{36}$/i.test(data.orgId) ? data.orgId : null;
    chrome.runtime.sendMessage({ type: 'streamUsage', windows, orgId }).catch(() => {});
  });
})();
