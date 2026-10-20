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
    return {
      ...THEMES[`${style}-${dark ? 'dark' : 'light'}`],
      ok: dark ? accent[0] : accent[1],
      hover: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
      onAccent: dark ? '#1b1510' : '#ffffff',
      style,
    };
  }

  const CSS = `
    :host { all: initial; }
    /* In the page's own flow, as a row above the composer, so claude.ai's layout makes
       room for it instead of being covered. Only the fallback below floats. */
    .strip {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 11px;
      row-gap: 7px;
      flex: 0 1 auto;
      max-width: 100%;
      margin-bottom: 8px;
      padding: 7px 10px 7px 13px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, "Segoe UI", -apple-system, sans-serif;
      font-size: 12px;
      line-height: 1.3;
    }
    /* The row the strip sits in, so the strip itself can be a flex item (see above). */
    .row {
      display: flex;
      justify-content: center;
      width: 100%;
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
    /* flex: none matters. Left shrinkable, a meter is squeezed narrower than its own text
       once peak hours makes the row longer than the composer, and nowrap text then spills
       over the divider beside it instead of the row growing or wrapping. */
    .meter { display: flex; align-items: center; gap: 7px; flex: none; }
    .name { color: var(--muted); white-space: nowrap; }
    .pct { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--level); }
    .track { width: 54px; height: 5px; border-radius: 999px; background: var(--track); overflow: hidden; flex: none; }
    /* A span is inline, and width and height do nothing to an inline box: without this the
       bar renders as an empty track. The track itself escapes that only by being a flex item. */
    .fill { display: block; height: 100%; border-radius: inherit; background: var(--level); }
    .reset { color: var(--muted); white-space: nowrap; }
    .note { color: var(--muted); }
    /* The gear and the close button travel as one: a row that wraps must not leave a lone
       × stranded on a line of its own. */
    .tools { display: flex; align-items: center; gap: 1px; flex: none; margin-left: -2px; }
    .close {
      flex: none;
      width: 20px; height: 20px;
      display: grid; place-items: center;
      margin-left: 2px;
      border: 0; border-radius: 6px;
      background: transparent; color: var(--muted);
      font: inherit; font-size: 14px; line-height: 1;
      cursor: pointer;
    }
    .close:hover { color: var(--text); }
    .divider { width: 1px; align-self: stretch; background: var(--border); flex: none; }
    /* On a wrapped line a divider would sit at the start of the row, marking nothing. */
    .strip--wrapped .divider { display: none; }
    .gear { font-size: 13px; }
    @media (max-width: 520px) { .reset { display: none; } }
  `;

  /* ---------- The gear menu ---------- */

  /*
   * What the strip shows, chosen from the strip itself — the settings people reach for while
   * looking at it. Everything else (theme, style, accent, size, the refresh interval, the
   * toolbar badge) stays on the extension's own Settings page, one click away at the bottom.
   *
   * It lives in a second shadow host attached to the page root rather than inside the strip,
   * because the strip sits inside claude.ai's composer, and anything that box clips or
   * scrolls would clip the menu with it.
   */

  const MENU_ITEMS = [
    { group: 'Show in strip' },
    { key: 'stripSession', label: 'Session' },
    { key: 'stripWeekly', label: 'Weekly' },
    { key: 'stripPeak', label: 'Peak hours' },
    { group: 'Details' },
    { key: 'stripSessionReset', label: 'Session reset time' },
    { key: 'stripWeeklyReset', label: 'Weekly reset time' },
    { key: 'stripBars', label: 'Usage bars' },
  ];

  const MENU_CSS = `
    :host { all: initial; }
    .menu {
      position: fixed;
      z-index: 2147483001;
      min-width: 210px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, "Segoe UI", -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.3;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
    }
    .group {
      padding: 8px 8px 4px;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 6px 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .item:hover { background: var(--hover); }
    .box {
      flex: none;
      width: 15px; height: 15px;
      display: grid; place-items: center;
      border: 1.5px solid var(--muted);
      border-radius: 4px;
      font-size: 11px;
      line-height: 1;
      color: transparent;
    }
    .item[aria-checked="true"] .box {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--on-accent);
    }
    .rule { height: 1px; margin: 7px 4px; background: var(--border); }
    .advanced { color: var(--muted); }
    .advanced:hover { color: var(--text); }
  `;

  let menuHost = null;
  let menuShadow = null;
  let menuOpen = false;
  // Where the gear was when the menu opened. Toggling an item resizes the strip, which moves
  // the gear; re-anchoring to it would slide the menu sideways under the pointer mid-click.
  let menuAnchor = null;

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuAnchor = null;
    if (menuHost) menuHost.remove();
  }

  function toggleMenu(settings) {
    if (menuOpen) {
      closeMenu();
      return;
    }
    const colours = palette(settings);
    menuHost = document.createElement('div');
    menuHost.id = 'usage-meter-strip-menu';
    menuShadow = menuHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = MENU_CSS;
    menuShadow.append(style);

    const panel = document.createElement('div');
    panel.className = 'menu';
    panel.setAttribute('role', 'menu');
    Object.entries({
      bg: colours.bg, border: colours.border, text: colours.text, muted: colours.muted,
      hover: colours.hover, accent: colours.ok, 'on-accent': colours.onAccent,
    }).forEach(([name, value]) => panel.style.setProperty(`--${name}`, value));

    for (const entry of MENU_ITEMS) {
      if (entry.group) {
        const heading = document.createElement('div');
        heading.className = 'group';
        heading.textContent = entry.group;
        panel.append(heading);
        continue;
      }
      const item = document.createElement('button');
      item.className = 'item';
      item.type = 'button';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(Boolean(settings[entry.key])));
      const box = document.createElement('span');
      box.className = 'box';
      box.textContent = '✓';
      const label = document.createElement('span');
      label.textContent = entry.label;
      item.append(box, label);
      item.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = item.getAttribute('aria-checked') !== 'true';
        item.setAttribute('aria-checked', String(next));
        const payload = await chrome.runtime.sendMessage({ type: 'setSetting', key: entry.key, value: next });
        if (payload && payload.state && payload.settings) render(payload.state, payload.settings);
      });
      panel.append(item);
    }

    const rule = document.createElement('div');
    rule.className = 'rule';
    const advanced = document.createElement('button');
    advanced.className = 'item advanced';
    advanced.type = 'button';
    advanced.setAttribute('role', 'menuitem');
    advanced.textContent = 'Advanced settings…';
    advanced.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    });
    panel.append(rule, advanced);

    menuShadow.append(panel);
    document.documentElement.append(menuHost);
    menuOpen = true;
    const gear = shadow && shadow.querySelector('.gear');
    menuAnchor = gear ? gear.getBoundingClientRect() : null;
    position(panel);
  }

  /** The menu holds the spot it opened at; a redraw underneath must not move it. */
  function repositionMenu() {
    if (!menuOpen || !menuShadow) return;
    const panel = menuShadow.querySelector('.menu');
    if (panel) position(panel);
  }

  /*
   * Above the gear, and never off the edge of the window.
   *
   * The gear is looked up afresh every time rather than captured: each render replaces the
   * whole strip, so a held reference becomes an element that is no longer in the page, whose
   * rectangle is all zeros — which threw the menu into the top-left corner after every click.
   */
  function position(panel, anchorRect) {
    const anchor = anchorRect || menuAnchor;
    if (!anchor) return;
    const box = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
    const above = anchor.top - box.height - 8;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(above >= 8 ? above : anchor.bottom + 8)}px`;
  }

  /* Listening in the capture phase means this runs before anything inside the menu, so a
     click on a checkbox would close the menu before it could act on it. Shadow DOM hides
     the real target from the event's `target` by design, so the composed path is what says
     whether the click landed in the menu or the strip. */
  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if ((menuHost && path.includes(menuHost)) || (host && path.includes(host))) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu, { passive: true });

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
    wrap.append(name);

    if (settings.stripBars) {
      const track = document.createElement('span');
      track.className = 'track';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = `${Math.max(0, Math.min(100, limit.percent))}%`;
      track.append(fill);
      track.dataset.drop = 'bars';
      wrap.append(track);
    }

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(limit.percent)}%`;
    wrap.append(pct);

    const wantsReset = limit.kind === 'session' ? settings.stripSessionReset : settings.stripWeeklyReset;
    if (wantsReset && limit.resetsAt) {
      const reset = document.createElement('span');
      reset.className = 'reset';
      reset.dataset.drop = limit.kind === 'session' ? 'sessionReset' : 'weeklyReset';
      reset.textContent = `· resets in ${countdown(limit.resetsAt)}`;
      wrap.append(reset);
    }
    return wrap;
  }

  /** Which limits the strip draws, in the order it draws them. */
  function visibleLimits(state, settings) {
    return (state.limits || []).filter((limit) => {
      if (limit.kind === 'session') return settings.stripSession;
      return settings.stripWeekly;
    }).slice(0, 3);
  }

  /** Peak hours, the same schedule the widget and the popup use. */
  function peakText() {
    const core = window.UsageCore;
    if (!core) return null;
    const status = core.getPeakStatus(new Date());
    if (!status.nextChange) return status.isPeak ? 'Peak hours' : 'Off-peak';
    const left = core.formatDuration(status.nextChange.getTime() - Date.now());
    return status.isPeak ? `Peak ends in ${left}` : `Peak in ${left}`;
  }

  function render(state, settings) {
    if (hidden) return;
    if (!shadow) mount();
    const colours = palette(settings);
    shadow.querySelectorAll('.row, .strip').forEach((el) => el.remove());

    const row = document.createElement('div');
    row.className = 'row';
    const strip = document.createElement('div');
    strip.className = 'strip';
    Object.entries({ bg: colours.bg, border: colours.border, text: colours.text, muted: colours.muted, track: colours.track })
      .forEach(([name, value]) => strip.style.setProperty(`--${name}`, value));
    strip.style.setProperty('--radius', colours.style === 'cozy' ? '14px' : '10px');

    const limits = visibleLimits(state, settings);
    if (limits.length) {
      limits.forEach((limit, i) => {
        if (i) {
          const divider = document.createElement('span');
          divider.className = 'divider';
          strip.append(divider);
        }
        strip.append(meter(limit, colours, settings));
      });
      if (settings.stripPeak) {
        const peak = peakText();
        if (peak) {
          const divider = document.createElement('span');
          divider.className = 'divider';
          divider.dataset.drop = 'peak';
          const note = document.createElement('span');
          note.className = 'reset';
          note.dataset.drop = 'peak';
          note.textContent = peak;
          strip.append(divider, note);
        }
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

    const gear = document.createElement('button');
    gear.className = 'close gear';
    gear.type = 'button';
    gear.title = 'What the strip shows';
    gear.setAttribute('aria-label', 'What the strip shows');
    gear.textContent = '⚙';
    gear.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu(settings);
    });

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Hide until this page reloads';
    close.setAttribute('aria-label', 'Hide the usage strip');
    close.textContent = '×';
    close.addEventListener('click', () => {
      hidden = true;
      closeMenu();
      shadow.querySelectorAll('.row').forEach((el) => el.remove());
    });
    const tools = document.createElement('span');
    tools.className = 'tools';
    tools.append(gear, close);
    strip.append(tools);
    row.append(strip);
    shadow.append(row);
    place();
    repositionMenu();

    requestAnimationFrame(() => fit(strip));
  }

  /*
   * Fitting the strip to the composer.
   *
   * A narrow composer, a wide system font or an extra limit can all push the row past the
   * width it has. Wrapping it is worse than it sounds: the line below holds whatever fell
   * off the end, which is usually nothing but the two buttons. So detail is dropped instead,
   * least useful first, until the row fits on one line — the percentages, which are the
   * point of the strip, are the last thing to go and never do.
   */
  const SHEDDING_ORDER = ['peak', 'weeklyReset', 'sessionReset', 'bars'];

  /** True while the row needs more than one line. Measured by height: items of different
      heights on one line sit at different tops, so tops cannot answer this. */
  function wraps(strip) {
    const items = [...strip.children].filter((item) => !item.classList.contains('divider'));
    if (items.length < 2) return false;
    const style = getComputedStyle(strip);
    const content = strip.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const tallest = Math.max(...items.map((item) => item.getBoundingClientRect().height));
    return content > tallest + 2;
  }

  function fit(strip) {
    if (!strip.isConnected) return;
    for (const part of SHEDDING_ORDER) {
      if (!wraps(strip)) break;
      const droppable = strip.querySelectorAll(`[data-drop="${part}"]`);
      if (!droppable.length) continue;
      droppable.forEach((el) => el.remove());
    }
    // Still too long — two limits with long names, say — so let it wrap after all.
    strip.classList.toggle('strip--wrapped', wraps(strip));
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
