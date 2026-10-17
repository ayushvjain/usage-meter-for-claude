'use strict';

/*
 * The popup. It draws the same panel as the desktop widget: the session limit large at the
 * top, the weekly limits under it, reset countdowns, and peak hours.
 *
 * The background worker owns the data, so this asks for whatever it already has the moment
 * the popup opens (it draws immediately, even on a cold worker) and then listens for the
 * refreshed state to arrive. Chrome closes the popup when the user clicks anywhere else,
 * so there is nothing to do for that.
 */

(() => {
  const core = window.UsageCore;
  const $ = (id) => document.getElementById(id);

  const els = {
    widget: $('widget'),
    limits: $('limits'),
    signin: $('signin'),
    signinBtn: $('signin-btn'),
    error: $('error'),
    errorText: $('error-text'),
    peak: $('peak'),
    peakLabel: $('peak-label'),
    peakCountdown: $('peak-countdown'),
    dayStrip: $('day-strip'),
    nowMarker: $('now-marker'),
    updated: $('updated'),
    next: $('next'),
    refresh: $('refresh'),
    menu: $('menu'),
    menuPopover: $('menu-popover'),
    orgName: $('org-name'),
    orgPicker: $('org-picker'),
    orgList: $('org-list'),
    free: $('free'),
    freeText: $('free-text'),
    freeBtn: $('free-btn'),
    sourceNote: $('source-note'),
    userTheme: $('user-theme'),
  };

  let state = null;
  let settings = null;
  let stripDayKey = null;

  const send = (type, payload) => chrome.runtime.sendMessage({ type, ...payload });

  /* ---------- Text helpers ---------- */

  function formatPercent(percent) {
    return String(Math.round(percent));
  }

  function resetText(limit, now) {
    if (!limit.resetsAt) {
      return limit.kind === 'session' ? 'Starts with your next message' : 'No reset scheduled';
    }
    const at = new Date(limit.resetsAt).getTime();
    if (Number.isNaN(at)) return '';
    const left = at - now;
    if (left <= 0) return 'Reset. Updating on the next refresh';
    if (left < 24 * 60 * 60 * 1000) return `Resets in ${core.formatDuration(left)}`;
    const when = new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `Resets ${when} (in ${core.formatDuration(left)})`;
  }

  function updatedText(fetchedAt, now) {
    if (!fetchedAt) return '';
    const ago = now - fetchedAt;
    if (ago < 60 * 1000) return 'Updated just now';
    if (ago < 60 * 60 * 1000) return `Updated ${Math.floor(ago / 60000)} min ago`;
    return `Updated ${new Date(fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }

  /* ---------- Rendering ---------- */

  function buildLimit(limit, thresholds) {
    const row = document.createElement('div');
    row.className = limit.kind === 'session' ? 'limit limit--hero' : 'limit';
    row.dataset.level = core.levelFor(limit.percent, thresholds);
    row.dataset.key = limit.key;

    const label = document.createElement('span');
    label.className = 'limit-label';
    label.textContent = limit.label;

    const value = document.createElement('span');
    value.className = 'limit-value';
    value.textContent = formatPercent(limit.percent);
    const unit = document.createElement('small');
    unit.textContent = '%';
    value.append(unit);

    const track = document.createElement('div');
    track.className = 'track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${limit.label} used`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', formatPercent(limit.percent));
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.setProperty('--p', `${limit.percent}%`);
    track.append(fill);

    const reset = document.createElement('div');
    reset.className = 'limit-reset';
    reset.dataset.resetsAt = limit.resetsAt || '';
    reset.dataset.kind = limit.kind;

    row.append(label, value, track, reset);
    return row;
  }

  /** One column of limits: the session first, then each weekly limit. */
  function renderLimits() {
    els.limits.replaceChildren();
    state.limits.forEach((limit) => els.limits.append(buildLimit(limit, settings)));

    if (state.status === 'ok' && state.limits.length === 0 && !state.unmetered) {
      const empty = document.createElement('p');
      empty.className = 'limit-reset';
      empty.textContent = 'claude.ai reported no usage limits for this account.';
      els.limits.append(empty);
    }
  }

  /** Theme, accent and size from Settings. Custom CSS can still override any of it. */
  function applyAppearance() {
    const root = document.documentElement;
    if (!settings || settings.theme === 'system' || !settings.theme) delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.style = (settings && settings.style) || 'cozy';
    root.dataset.accent = (settings && settings.accent) || 'clay';
    // The browser sizes the popup to the page, so zooming the page resizes the popup with it.
    document.body.style.zoom = String(core.clampScale(settings && settings.scale));
    els.userTheme.textContent = (settings && settings.customCss) || '';
  }

  function renderOrgChoices() {
    els.orgList.replaceChildren();
    (state.orgChoices || []).forEach((org) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'org-option';
      button.setAttribute('role', 'listitem');
      const name = document.createElement('span');
      name.className = 'org-option-name';
      name.textContent = org.name;
      button.append(name);
      button.addEventListener('click', () => send('chooseOrg', { uuid: org.uuid }).then(apply));
      els.orgList.append(button);
    });
  }

  function render() {
    if (!state) return;
    applyAppearance();
    els.widget.dataset.status = state.status;
    els.refresh.disabled = state.status === 'loading';

    const needsSignIn = state.status === 'auth';
    const needsOrg = state.status === 'choose-org';
    els.signin.hidden = !needsSignIn;
    els.orgPicker.hidden = !needsOrg;
    els.limits.hidden = needsSignIn || needsOrg;
    if (needsOrg) renderOrgChoices();

    const showError = state.status === 'error' && Boolean(state.message);
    els.error.hidden = !showError;
    els.errorText.textContent = showError
      ? state.limits.length
        ? `${state.message} Showing the last values.`
        : state.message
      : '';

    renderFree();
    els.peak.hidden = !(settings && settings.showPeakHours);

    const showOrg = state.orgCount > 1 && state.org && state.org.name;
    els.orgName.hidden = !showOrg;
    els.orgName.textContent = showOrg ? state.org.name : '';
    els.orgName.title = showOrg ? state.org.name : '';

    renderLimits();
    tick();
  }

  /*
   * What a Free plan sees. claude.ai answers the usage endpoint for these accounts but puts
   * nothing in it, so the only figures that exist are the ones the page reader hears as a
   * reply arrives. Three cases: the reader is off and can be turned on; it is on but no
   * reply has come yet; or there are numbers, drawn as ordinary limits with a note saying
   * where they came from.
   */
  function renderFree() {
    const unmetered = Boolean(state.unmetered);
    const tracking = Boolean(settings && settings.trackFreeUsage);
    const haveNumbers = state.limits.length > 0;

    els.free.hidden = !unmetered || haveNumbers;
    els.freeBtn.hidden = tracking;
    els.sourceNote.hidden = !(haveNumbers && state.source === 'stream');

    if (els.free.hidden) return;
    const reader = state.reader || {};
    if (!tracking) {
      els.freeText.textContent =
        'claude.ai reports no usage figures for Free plans. They can be read from your chats instead, as each reply arrives.';
    } else if (reader.timelines && !reader.readings) {
      // The reader is working; this account's replies simply aren't in a form it can read.
      els.freeText.textContent =
        "This account's chats use claude.ai's newer transport, which sends usage in a form the extension can't read yet. Nothing to do on your side.";
    } else if (reader.error) {
      els.freeText.textContent = `The page reader couldn't start: ${reader.error}`;
    } else {
      els.freeText.textContent =
        'Waiting for your next message on claude.ai. Free plans report usage only as a reply arrives.';
    }
  }

  function renderDayStrip(now) {
    const day = new Date(now);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    if (key === stripDayKey) return;
    stripDayKey = key;
    els.dayStrip.querySelectorAll('.segment').forEach((s) => s.remove());
    core.peakSegmentsForLocalDay(now).forEach((seg) => {
      const el = document.createElement('div');
      el.className = 'segment';
      el.style.left = `${seg.from * 100}%`;
      el.style.width = `${(seg.to - seg.from) * 100}%`;
      els.dayStrip.insertBefore(el, els.nowMarker);
    });
  }

  function tickPeak(now) {
    if (els.peak.hidden) return;
    const status = core.getPeakStatus(new Date(now));
    els.peak.dataset.state = status.isPeak ? 'peak' : 'off';
    els.peakLabel.textContent = status.isPeak ? 'Peak hours' : 'Off-peak';
    if (status.nextChange) {
      const left = core.formatDuration(status.nextChange.getTime() - now);
      els.peakCountdown.textContent = status.isPeak ? `Ends in ${left}` : `Peak starts in ${left}`;
    } else {
      els.peakCountdown.textContent = '';
    }
    renderDayStrip(now);
    els.nowMarker.style.left = `${core.localDayFraction(now) * 100}%`;
  }

  function tick() {
    if (!state) return;
    const now = Date.now();

    els.limits.querySelectorAll('.limit-reset[data-kind]').forEach((el) => {
      el.textContent = resetText({ resetsAt: el.dataset.resetsAt || null, kind: el.dataset.kind }, now);
    });

    tickPeak(now);

    if (state.status === 'loading') {
      els.updated.textContent = state.fetchedAt ? updatedText(state.fetchedAt, now) : 'Refreshing…';
      els.next.textContent = state.fetchedAt ? 'Refreshing…' : '';
    } else if (state.status === 'choose-org' || state.status === 'auth') {
      els.updated.textContent = '';
      els.next.textContent = '';
    } else {
      els.updated.textContent = updatedText(state.fetchedAt, now);
      els.next.textContent = state.nextRefreshAt ? `Next refresh in ${core.formatClock(state.nextRefreshAt - now)}` : '';
    }
  }

  /* ---------- Menu ---------- */

  function setMenuOpen(open) {
    els.menuPopover.hidden = !open;
    els.menu.setAttribute('aria-expanded', String(open));
    if (open) els.menuPopover.querySelector('.menu-item').focus();
  }

  els.menu.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(els.menuPopover.hidden);
  });

  // A click anywhere else in the popup closes the menu. A click outside the popup closes
  // the popup itself, which Chrome does for us.
  document.addEventListener('click', () => setMenuOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.menuPopover.hidden) {
      setMenuOpen(false);
      els.menu.focus();
    }
  });

  const COMMANDS = {
    refresh: () => refresh(),
    settings: () => send('openOptions').then(() => window.close()),
    claude: () => send('openClaude').then(() => window.close()),
  };

  els.menuPopover.addEventListener('click', (e) => {
    const item = e.target.closest('[data-command]');
    if (!item) return;
    setMenuOpen(false);
    COMMANDS[item.dataset.command]();
  });

  /* ---------- Wiring ---------- */

  function apply(payload) {
    if (!payload || payload.error) return;
    state = payload.state;
    settings = payload.settings;
    render();
  }

  function refresh() {
    if (state && state.status === 'loading') return;
    if (state) {
      state = { ...state, status: 'loading' };
      render();
    }
    send('refresh').then(apply);
  }

  els.refresh.addEventListener('click', refresh);
  // One button, both halves: read the usage, and put it on the page where it is useful.
  els.freeBtn.addEventListener('click', async () => {
    els.freeBtn.disabled = true;
    await send('setSetting', { key: 'showStrip', value: true });
    const payload = await send('setSetting', { key: 'trackFreeUsage', value: true });
    els.freeBtn.disabled = false;
    apply(payload);
  });
  els.signinBtn.addEventListener('click', () => send('openClaude').then(() => window.close()));

  // Updates pushed by the background worker while the popup is open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'state') apply(message);
  });

  send('popupOpened').then(apply);
  setInterval(tick, 1000);
})();
