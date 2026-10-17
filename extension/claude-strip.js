'use strict';

/*
 * The usage strip: the same figures the popup shows, pinned to the bottom of claude.ai so
 * they are in front of you while you chat instead of a click away. Registered only while
 * "Show the usage strip on claude.ai" is on in Settings.
 *
 * It lives in a shadow root, so claude.ai's stylesheet cannot reach into it and its own
 * styles cannot leak out. It reads nothing from the page and writes nothing to it beyond
 * its own element: the numbers come from the extension's worker, the same ones the popup
 * draws, whether they were reported by claude.ai or read from a reply.
 */

(() => {
  if (window.__usageMeterStrip) return;
  window.__usageMeterStrip = true;

  const POLL_MS = 20000;
  let hidden = false;
  let shadow = null;
  let timer = null;

  /* ---------- Palette: the popup's, pared down to what the strip draws ---------- */

  const ACCENTS = {
    clay: ['#e3895f', '#c4643f'],
    teal: ['#56c6b0', '#1a9682'],
    blue: ['#6aa8ff', '#2563eb'],
    violet: ['#a796f5', '#6c58d6'],
    amber: ['#f2b544', '#b7790a'],
    rose: ['#f48fb1', '#c2416f'],
  };

  const THEMES = {
    'cozy-dark': { bg: '#292521', border: 'rgba(242,236,227,0.14)', text: '#f2ece3', muted: '#b5aa9b', track: 'rgba(242,236,227,0.12)', warn: '#e0a84e', danger: '#e06a52' },
    'cozy-light': { bg: '#faf6ef', border: 'rgba(59,50,42,0.16)', text: '#3b322a', muted: '#857565', track: 'rgba(59,50,42,0.11)', warn: '#b8801c', danger: '#b84a33' },
    'classic-dark': { bg: '#131b29', border: 'rgba(255,255,255,0.1)', text: '#e9eef5', muted: '#8e9bb0', track: 'rgba(255,255,255,0.1)', warn: '#f2b544', danger: '#f07178' },
    'classic-light': { bg: '#f7f9fc', border: 'rgba(16,28,48,0.12)', text: '#16202e', muted: '#5b6980', track: 'rgba(16,28,48,0.1)', warn: '#c4860a', danger: '#d2414d' },
  };

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function palette(settings) {
    const dark = settings.theme === 'dark' || (settings.theme !== 'light' && prefersDark());
    const style = settings.style === 'classic' ? 'classic' : 'cozy';
    const accent = ACCENTS[settings.accent] || ACCENTS.clay;
    return { ...THEMES[`${style}-${dark ? 'dark' : 'light'}`], ok: dark ? accent[0] : accent[1], style };
  }

  const CSS = `
    :host { all: initial; }
    .strip {
      position: fixed;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 14px;
      max-width: min(560px, calc(100vw - 32px));
      padding: 8px 10px 8px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, "Segoe UI", -apple-system, sans-serif;
      font-size: 12px;
      line-height: 1.3;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    }
    .meter { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .name { color: var(--muted); white-space: nowrap; }
    .pct { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--level); }
    .track { width: 54px; height: 5px; border-radius: 999px; background: var(--track); overflow: hidden; flex: none; }
    /* A span is inline, and width and height do nothing to an inline box: without this the
       bar renders as an empty track. The track itself escapes that only by being a flex item. */
    .fill { display: block; height: 100%; border-radius: inherit; background: var(--level); }
    .reset { color: var(--muted); white-space: nowrap; }
    .note { color: var(--muted); }
    .close {
      flex: none;
      width: 22px; height: 22px;
      display: grid; place-items: center;
      margin-left: 2px;
      border: 0; border-radius: 6px;
      background: transparent; color: var(--muted);
      font: inherit; font-size: 14px; line-height: 1;
      cursor: pointer;
    }
    .close:hover { color: var(--text); }
    @media (max-width: 520px) { .reset { display: none; } }
  `;

  function mount() {
    const host = document.createElement('div');
    host.id = 'usage-meter-strip';
    // The page may re-render its own tree; keeping the host on documentElement keeps the
    // strip out of anything claude.ai replaces.
    (document.documentElement || document.body).append(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    return shadow;
  }

  function levelFor(percent, settings) {
    if (percent >= (settings.dangerAt || 85)) return 'danger';
    if (percent >= (settings.warnAt || 60)) return 'warn';
    return 'ok';
  }

  function countdown(iso) {
    if (!iso) return '';
    const left = new Date(iso).getTime() - Date.now();
    if (!(left > 0)) return 'resetting';
    const minutes = Math.floor(left / 60000);
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function meter(limit, colours, settings) {
    const wrap = document.createElement('span');
    wrap.className = 'meter';
    wrap.style.setProperty('--level', colours[levelFor(limit.percent, settings)]);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = limit.kind === 'session' ? 'Session' : limit.scoped ? limit.label.replace(/^Weekly, /, '') : 'Weekly';

    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.width = `${Math.max(0, Math.min(100, limit.percent))}%`;
    track.append(fill);

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(limit.percent)}%`;

    wrap.append(name, track, pct);
    return wrap;
  }

  function render(state, settings) {
    if (hidden) return;
    if (!shadow) mount();
    const colours = palette(settings);
    shadow.querySelectorAll('.strip').forEach((el) => el.remove());

    const strip = document.createElement('div');
    strip.className = 'strip';
    Object.entries({ bg: colours.bg, border: colours.border, text: colours.text, muted: colours.muted, track: colours.track })
      .forEach(([name, value]) => strip.style.setProperty(`--${name}`, value));
    strip.style.setProperty('--radius', colours.style === 'cozy' ? '14px' : '10px');

    const limits = (state.limits || []).slice(0, 3);
    if (limits.length) {
      limits.forEach((limit) => strip.append(meter(limit, colours, settings)));
      const session = limits.find((l) => l.kind === 'session') || limits[0];
      if (session && session.resetsAt) {
        const reset = document.createElement('span');
        reset.className = 'reset';
        reset.textContent = `resets in ${countdown(session.resetsAt)}`;
        strip.append(reset);
      }
    } else {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent =
        state.status === 'auth' ? 'Sign in to claude.ai to see your usage.'
        : state.unmetered && state.reader && state.reader.timelines && !state.reader.readings
          ? "This account's chats use a transport the meter can't read yet."
        : state.unmetered ? 'Usage will appear after your next message.'
        : 'No usage to show yet.';
      strip.append(note);
    }

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Hide until this page reloads';
    close.setAttribute('aria-label', 'Hide the usage strip');
    close.textContent = '×';
    close.addEventListener('click', () => {
      hidden = true;
      shadow.querySelectorAll('.strip').forEach((el) => el.remove());
    });
    strip.append(close);
    shadow.append(strip);
  }

  async function update() {
    try {
      const payload = await chrome.runtime.sendMessage({ type: 'get' });
      if (payload && payload.state && payload.settings) render(payload.state, payload.settings);
    } catch {
      // The worker is restarting, or the extension was reloaded. Try again on the next tick.
    }
  }

  // A reply just reported usage: give the worker a moment to store it, then redraw.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!event.data || event.data.source !== 'usage-meter-reader') return;
    setTimeout(update, 400);
  });

  update();
  timer = setInterval(update, POLL_MS);
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
