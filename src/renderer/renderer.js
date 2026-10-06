'use strict';

(() => {
  const core = window.UsageCore;
  const meter = window.meter;
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
    content: $('content'),
    footer: $('footer'),
    orgName: $('org-name'),
    orgPicker: $('org-picker'),
    orgList: $('org-list'),
  };

  let state = null;
  let stripDayKey = null;

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

  function renderLimits() {
    const thresholds = state.settings || {};
    els.limits.replaceChildren();

    state.limits.forEach((limit) => {
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
      els.limits.append(row);
    });

    if (state.status === 'ok' && state.limits.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'limit-reset';
      empty.textContent = 'claude.ai reported no usage limits for this account.';
      els.limits.append(empty);
    }
  }

  /** Theme, accent and opacity from Settings. Custom CSS can still override any of it. */
  function applyAppearance(settings) {
    const root = document.documentElement;
    if (!settings || settings.theme === 'system' || !settings.theme) delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    if (settings && settings.accent && settings.accent !== 'teal') root.dataset.accent = settings.accent;
    else delete root.dataset.accent;
    const opacity = settings && Number(settings.opacity);
    if (Number.isFinite(opacity)) root.style.setProperty('--bg-alpha', String(opacity / 100));
  }

  function render() {
    if (!state) return;
    applyAppearance(state.settings);
    els.widget.dataset.status = state.status;
    els.refresh.disabled = state.status === 'loading';

    const needsSignIn = state.status === 'auth';
    const needsOrg = state.status === 'choose-org';
    els.signin.hidden = !needsSignIn;
    els.signinBtn.disabled = Boolean(state.signInPending);
    els.signinBtn.textContent = state.signInPending ? 'Opening sign-in…' : 'Sign in';
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

    els.peak.hidden = !(state.settings && state.settings.showPeakHours);

    const showOrg = state.orgCount > 1 && state.org && state.org.name;
    els.orgName.hidden = !showOrg;
    els.orgName.textContent = showOrg ? state.org.name : '';
    els.orgName.title = showOrg ? state.org.name : '';

    renderLimits();
    tick();
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
      if (org.active) {
        const note = document.createElement('span');
        note.className = 'org-option-note';
        note.textContent = 'Selected on claude.ai right now';
        button.append(note);
      }
      button.addEventListener('click', () => meter.chooseOrg(org.uuid));
      els.orgList.append(button);
    });
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
      els.updated.textContent = 'Refreshing…';
      els.next.textContent = '';
    } else if (state.status === 'choose-org' || state.status === 'auth') {
      els.updated.textContent = '';
      els.next.textContent = '';
    } else {
      els.updated.textContent = updatedText(state.fetchedAt, now);
      els.next.textContent = state.nextRefreshAt ? `Next refresh in ${core.formatClock(state.nextRefreshAt - now)}` : '';
    }
  }

  /* ---------- Window sizing ---------- */

  // Reports how tall the panel needs to be. The main process rounds that up to whole
  // desktop tiles, and the panel stretches to fill them with the footer at the bottom.
  function reportHeight() {
    const style = getComputedStyle(els.widget);
    const px = (name) => parseFloat(style[name]) || 0;
    const chrome = px('paddingTop') + px('paddingBottom') + px('borderTopWidth') + px('borderBottomWidth');
    const gap = parseFloat(style.rowGap) || 0;
    meter.resize(Math.ceil(els.content.offsetHeight + gap + els.footer.offsetHeight + chrome));
  }

  const resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(els.content);
  resizeObserver.observe(els.footer);

  /* ---------- Wiring ---------- */

  els.refresh.addEventListener('click', () => {
    if (state && state.status === 'loading') return;
    meter.refresh();
  });
  els.menu.addEventListener('click', () => meter.openMenu());
  els.signinBtn.addEventListener('click', () => meter.signIn());

  meter.onState((next) => {
    state = next;
    render();
  });

  meter.onTheme((css) => {
    $('user-theme').textContent = css;
  });

  setInterval(tick, 1000);
  meter.ready();
})();