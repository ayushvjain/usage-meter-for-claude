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

  /*
   * On "System" the strip follows claude.ai rather than the operating system. They disagree
   * more often than you would think — claude.ai keeps its own theme setting — and a light
   * strip on a dark page is the one way this cannot help but look bolted on.
   */
  function pageIsDark() {
    const root = document.documentElement;
    if (root.classList.contains('dark') || root.dataset.theme === 'dark') return true;
    if (root.classList.contains('light') || root.dataset.theme === 'light') return false;
    const background = getComputedStyle(document.body || root).backgroundColor || '';
    const rgb = background.match(/\d+(\.\d+)?/g);
    if (rgb && rgb.length >= 3 && (rgb.length < 4 || Number(rgb[3]) > 0)) {
      const [r, g, b] = rgb.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function palette(settings) {
    const dark = settings.theme === 'dark' || (settings.theme !== 'light' && pageIsDark());
    const style = settings.style === 'classic' ? 'classic' : 'cozy';
    const accent = ACCENTS[settings.accent] || ACCENTS.clay;
    return { ...THEMES[`${style}-${dark ? 'dark' : 'light'}`], ok: dark ? accent[0] : accent[1], style };
  }

  const CSS = `
    :host { all: initial; }
    /* In the page's own flow, as a row above the composer, so claude.ai's layout makes
       room for it instead of being covered. Only the fallback below floats. */
    .strip {
      display: flex;
      align-items: center;
      gap: 14px;
      width: max-content;
      max-width: 100%;
      margin: 0 auto 8px;
      padding: 7px 10px 7px 13px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, "Segoe UI", -apple-system, sans-serif;
      font-size: 12px;
      line-height: 1.3;
    }
    /* No composer to sit above: float at the bottom of the window rather than vanish. */
    .strip--loose {
      position: fixed;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      z-index: 2147483000;
      margin: 0;
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

  /* ---------- Where the strip lives ---------- */

  /*
   * The strip goes into claude.ai's own layout, as a row directly above the composer, so
   * the page makes room for it: nothing is covered, and it rises and falls with the box as
   * that grows with a long prompt or an attachment, with no measuring or following to do.
   *
   * claude.ai's markup is its own and can change, so the composer is found by what it is —
   * the editable area, then out to the <fieldset> or <form> around it — never by a class
   * name. With no composer to be found (another part of the site, or markup this no longer
   * recognises) the strip floats at the bottom of the window instead of disappearing.
   */

  let host = null;

  function findEditor() {
    const candidates = [
      ...document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"], textarea'),
    ].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 120 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    // The composer is the lowest editable box on screen; an edit box higher up is not it.
    return candidates.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).pop() || null;
  }

  /** The element to put the strip in front of: the composer as the page lays it out. */
  function findMountTarget() {
    const editor = findEditor();
    if (!editor) return null;

    let wrapper = null;
    let node = editor;
    for (let i = 0; i < 12 && node.parentElement; i += 1) {
      node = node.parentElement;
      if (node.tagName === 'FIELDSET' || node.tagName === 'FORM') {
        wrapper = node;
        break;
      }
    }
    // No form around it: climb out of the input while each parent is still roughly the same
    // box, which stops at the visible composer card rather than at the page.
    if (!wrapper) {
      wrapper = editor;
      for (let i = 0; i < 8; i += 1) {
        const parent = wrapper.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        const outer = parent.getBoundingClientRect();
        const inner = wrapper.getBoundingClientRect();
        if (outer.width - inner.width > 160 || outer.height - inner.height > 160) break;
        wrapper = parent;
      }
    }

    // A row would put the strip beside the composer rather than above it, so climb until
    // the parent stacks its children.
    for (let i = 0; i < 4; i += 1) {
      const parent = wrapper.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const style = getComputedStyle(parent);
      const isRow = style.display.includes('flex') && style.flexDirection.startsWith('row');
      if (!isRow) break;
      wrapper = parent;
    }
    return wrapper.parentElement ? wrapper : null;
  }

  /*
   * Re-inserting into someone else's React tree can turn into a fight: React removes the
   * node it does not know about, this puts it back, and round it goes. A burst of
   * re-inserts means that is happening, so the strip stops trying and floats instead.
   */
  const REINSERT_LIMIT = 12;
  const REINSERT_WINDOW_MS = 5000;
  let reinserts = [];
  let floatOnly = false;

  /** Puts the strip where it belongs, in the page or floating, and says whether it moved. */
  function place() {
    if (!host || hidden) return false;
    const strip = shadow.querySelector('.strip');

    /* A page that rebuilds itself by re-serialising its HTML (claude.ai does, moving between
       chats) copies this host as a plain, empty <div> — a shadow root does not survive being
       written out as text. The copy keeps the id while the real host, with the strip in it,
       is left detached. Clear out any such impostor before looking at where things stand. */
    for (const other of document.querySelectorAll('#usage-meter-strip')) {
      if (other !== host) other.remove();
    }

    const target = floatOnly ? null : findMountTarget();

    if (!target) {
      if (host.parentElement !== document.documentElement) document.documentElement.append(host);
      host.style.cssText = '';
      if (strip) strip.classList.add('strip--loose');
      return true;
    }

    if (strip) strip.classList.remove('strip--loose');
    // Stays as wide as its content, centred over the composer, never wider than the page.
    host.style.cssText = 'display:block;width:100%;flex:none;align-self:stretch;';
    if (host.nextElementSibling === target && host.parentElement === target.parentElement) return false;

    const now = Date.now();
    reinserts = reinserts.filter((at) => now - at < REINSERT_WINDOW_MS);
    reinserts.push(now);
    if (reinserts.length > REINSERT_LIMIT) {
      floatOnly = true;
      document.documentElement.append(host);
      host.style.cssText = '';
      if (strip) strip.classList.add('strip--loose');
      return true;
    }

    target.parentElement.insertBefore(host, target);
    return true;
  }

  function mount() {
    host = document.createElement('div');
    host.id = 'usage-meter-strip';
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
    place();
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

  /* Being in the page's flow means the strip rides along with the composer on its own:
     nothing to measure, nothing to follow. What does have to be watched is claude.ai
     rebuilding its tree — moving between chats, or React re-rendering the composer — which
     drops the strip out of the page. Then it goes back in. */
  let pending = null;
  new MutationObserver(() => {
    if (hidden) return;
    clearTimeout(pending);
    pending = setTimeout(place, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // A backstop for a rebuild that somehow stirs no mutations this observer sees.
  const anchorTimer = setInterval(place, 1500);

  update();
  timer = setInterval(update, POLL_MS);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    clearInterval(anchorTimer);
  });
})();
