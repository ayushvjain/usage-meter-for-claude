'use strict';

/*
 * The Settings page. Same controls as the desktop app's Settings window, minus the ones
 * that only make sense for a desktop widget (opacity, position, start with Windows) and
 * plus the toolbar badge. Every change is saved straight away and pushed to the popup.
 */

(() => {
  const core = window.UsageCore;
  const $ = (id) => document.getElementById(id);
  const send = (type, payload) => chrome.runtime.sendMessage({ type, ...payload });

  const ACCENT_COLOURS = { clay: '#e3895f', teal: '#56c6b0', blue: '#6aa8ff', violet: '#a796f5', amber: '#f2b544', rose: '#f48fb1' };
  const ACCENT_NAMES = { clay: 'Clay', teal: 'Teal', blue: 'Blue', violet: 'Violet', amber: 'Amber', rose: 'Rose' };
  const REFRESH_CHOICES = [1, 2, 5, 10, 15, 30];

  let built = false;

  /* ---------- Tabs ---------- */

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

  function selectTab(tab) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !selected;
    });
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });

  /* ---------- Helpers ---------- */

  const setSetting = (key, value) => send('setSetting', { key, value }).then(render);

  function setChecked(group, value) {
    group.querySelectorAll('[role="radio"]').forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function bindRadioGroup(group, key) {
    group.addEventListener('click', (e) => {
      const button = e.target.closest('[role="radio"]');
      if (!button) return;
      setChecked(group, button.dataset.value);
      setSetting(key, button.dataset.value);
    });
    group.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const buttons = Array.from(group.querySelectorAll('[role="radio"]'));
      const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = buttons[(current + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
    });
  }

  function applyTheme(settings) {
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.accent = settings.accent;
    root.dataset.style = settings.style;
  }

  /* ---------- Build controls once ---------- */

  function build() {
    const refresh = $('refresh-minutes');
    REFRESH_CHOICES.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = m === 1 ? '1 minute' : `${m} minutes`;
      refresh.append(opt);
    });
    refresh.addEventListener('change', () => setSetting('refreshMinutes', Number(refresh.value)));

    $('show-peak').addEventListener('change', (e) => setSetting('showPeakHours', e.target.checked));
    $('show-badge').addEventListener('change', (e) => setSetting('showBadge', e.target.checked));
    $('track-free').addEventListener('change', (e) => setSetting('trackFreeUsage', e.target.checked));

    bindRadioGroup($('style'), 'style');
    bindRadioGroup($('theme'), 'theme');

    const accent = $('accent');
    core.ACCENTS.forEach((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.setAttribute('role', 'radio');
      b.dataset.value = name;
      b.title = ACCENT_NAMES[name] || name;
      b.setAttribute('aria-label', ACCENT_NAMES[name] || name);
      b.style.setProperty('--swatch', ACCENT_COLOURS[name] || '#888');
      accent.append(b);
    });
    bindRadioGroup(accent, 'accent');

    const scale = $('scale');
    scale.min = String(Math.round(core.SCALE_RANGE.min * 100));
    scale.max = String(Math.round(core.SCALE_RANGE.max * 100));
    scale.step = String(Math.round(core.SCALE_RANGE.step * 100));
    let scaleTimer = null;
    scale.addEventListener('input', () => {
      $('scale-value').value = `${scale.value}%`;
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => setSetting('scale', Number(scale.value) / 100), 120);
    });
    $('scale-reset').addEventListener('click', () => setSetting('scale', 1));

    // Custom CSS saves a moment after typing stops, so every keystroke isn't a write.
    const css = $('custom-css');
    let cssTimer = null;
    css.addEventListener('input', () => {
      clearTimeout(cssTimer);
      $('css-saved').textContent = '';
      cssTimer = setTimeout(() => {
        setSetting('customCss', css.value);
        $('css-saved').textContent = 'Saved.';
      }, 500);
    });

    $('org').addEventListener('change', (e) => send('chooseOrg', { uuid: e.target.value }).then(render));
    $('open-claude').addEventListener('click', () => send('openClaude'));

    built = true;
  }

  /* ---------- Render ---------- */

  function renderAccount(state, settings) {
    const card = $('account-card');
    const signedIn = state.status !== 'auth';
    card.dataset.state = signedIn ? 'signed-in' : 'signed-out';

    if (!signedIn) {
      $('account-title').textContent = 'Not signed in to claude.ai';
      $('account-sub').textContent = 'Sign in on claude.ai in this browser, then refresh the popup.';
    } else if (state.status === 'choose-org') {
      $('account-title').textContent = 'Signed in';
      $('account-sub').textContent = 'Choose an organization below to show its usage.';
    } else {
      $('account-title').textContent = 'Signed in';
      $('account-sub').textContent = state.org ? state.org.name : 'Checking your account…';
    }

    const orgs = state.orgs || [];
    const orgRow = $('org-row');
    const org = $('org');
    orgRow.hidden = state.orgCount < 2;
    if (!orgRow.hidden) {
      org.replaceChildren();
      if (!settings.orgId) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose…';
        placeholder.disabled = true;
        placeholder.selected = true;
        org.append(placeholder);
      }
      orgs.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.uuid;
        opt.textContent = o.name;
        opt.selected = o.uuid === settings.orgId;
        org.append(opt);
      });
    }
  }

  function render(payload) {
    if (!payload || payload.error) return;
    const { state, settings } = payload;
    if (!built) build();
    applyTheme(settings);

    $('refresh-minutes').value = String(settings.refreshMinutes);
    $('show-peak').checked = settings.showPeakHours;
    $('show-badge').checked = settings.showBadge;
    $('track-free').checked = settings.trackFreeUsage;

    setChecked($('style'), settings.style);
    setChecked($('theme'), settings.theme);
    setChecked($('accent'), settings.accent);

    const scale = $('scale');
    if (document.activeElement !== scale) scale.value = String(Math.round(settings.scale * 100));
    $('scale-value').value = `${scale.value}%`;

    const css = $('custom-css');
    if (document.activeElement !== css) css.value = settings.customCss || '';

    renderAccount(state, settings);

    $('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
  }

  // The popup and the background worker can both change things while this page is open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'state') render(message);
  });

  send('get').then(render);
})();
