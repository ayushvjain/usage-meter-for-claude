'use strict';

(() => {
  const meter = window.meter;
  const $ = (id) => document.getElementById(id);

  const ACCENT_COLOURS = { clay: '#e3895f', teal: '#56c6b0', blue: '#6aa8ff', violet: '#a796f5', amber: '#f2b544', rose: '#f48fb1' };
  const ACCENT_NAMES = { clay: 'Clay', teal: 'Teal', blue: 'Blue', violet: 'Violet', amber: 'Amber', rose: 'Rose' };

  let snapshot = null;
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
      meter.setSetting(key, button.dataset.value);
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

  function build(s) {
    const refresh = $('refresh-minutes');
    s.options.refreshChoices.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = m === 1 ? '1 minute' : `${m} minutes`;
      refresh.append(opt);
    });
    refresh.addEventListener('change', () => meter.setSetting('refreshMinutes', Number(refresh.value)));

    $('show-peak').addEventListener('change', (e) => meter.setSetting('showPeakHours', e.target.checked));
    $('start-with-windows').addEventListener('change', (e) => meter.setSetting('startWithWindows', e.target.checked));

    bindRadioGroup($('style'), 'style');
    bindRadioGroup($('theme'), 'theme');

    const accent = $('accent');
    s.options.accents.forEach((name) => {
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

    const opacity = $('opacity');
    opacity.min = String(s.options.opacity.min);
    opacity.max = String(s.options.opacity.max);
    opacity.step = '5';
    let opacityTimer = null;
    opacity.addEventListener('input', () => {
      $('opacity-value').value = `${opacity.value}%`;
    const scale = $('scale');
    if (document.activeElement !== scale) scale.value = String(Math.round(st.scale * 100));
    $('scale-value').value = `${scale.value}%`;
      clearTimeout(opacityTimer);
      opacityTimer = setTimeout(() => meter.setSetting('opacity', Number(opacity.value)), 120);
    });

    const scale = $('scale');
    scale.min = String(Math.round(s.options.scale.min * 100));
    scale.max = String(Math.round(s.options.scale.max * 100));
    scale.step = String(Math.round(s.options.scale.step * 100));
    let scaleTimer = null;
    scale.addEventListener('input', () => {
      $('scale-value').value = `${scale.value}%`;
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => meter.setSetting('scale', Number(scale.value) / 100), 120);
    });
    $('scale-reset').addEventListener('click', () => meter.setSetting('scale', 1));

    $('org').addEventListener('change', (e) => meter.chooseOrg(e.target.value));
    $('sign-in').addEventListener('click', () => meter.signIn());
    $('sign-out').addEventListener('click', () => meter.signOut());

    document.querySelectorAll('[data-action]').forEach((b) => {
      b.addEventListener('click', () => meter.action(b.dataset.action));
    });

    built = true;
  }

  /* ---------- Render ---------- */

  function renderAccount(account) {
    const card = $('account-card');
    const signedIn = account.status !== 'auth';
    card.dataset.state = signedIn ? 'signed-in' : 'signed-out';

    if (!signedIn) {
      $('account-title').textContent = 'Not signed in';
      $('account-sub').textContent = 'Sign in to claude.ai to see your usage.';
    } else if (account.status === 'choose-org') {
      $('account-title').textContent = 'Signed in';
      $('account-sub').textContent = 'Choose an organization below to show its usage.';
    } else {
      $('account-title').textContent = 'Signed in';
      $('account-sub').textContent = account.org ? account.org.name : 'Checking your account…';
    }

    const signInBtn = $('sign-in');
    signInBtn.hidden = signedIn;
    signInBtn.disabled = Boolean(account.signInPending);
    signInBtn.textContent = account.signInPending ? 'Opening…' : 'Sign in';
    $('sign-out').hidden = !signedIn;

    const orgRow = $('org-row');
    const org = $('org');
    orgRow.hidden = account.orgs.length < 2;
    if (account.orgs.length >= 2) {
      org.replaceChildren();
      if (!account.chosenOrgId) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose…';
        placeholder.disabled = true;
        placeholder.selected = true;
        org.append(placeholder);
      }
      account.orgs.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.uuid;
        opt.textContent = o.name;
        opt.selected = o.uuid === account.chosenOrgId;
        org.append(opt);
      });
    }
  }

  function render(s) {
    snapshot = s;
    if (!built) build(s);
    const st = s.settings;
    applyTheme(st);

    $('refresh-minutes').value = String(st.refreshMinutes);
    $('show-peak').checked = st.showPeakHours;

    // The wording and availability come from the platform (Windows, macOS, ...).
    const login = s.app.loginItem;
    const start = $('start-with-windows');
    start.checked = st.startWithWindows;
    start.disabled = login.managedElsewhere;
    $('start-label').textContent = login.label;
    $('start-note').textContent = login.managedElsewhere ? login.managedNote : login.note;

    setChecked($('style'), st.style);
    setChecked($('theme'), st.theme);
    setChecked($('accent'), st.accent);
    const opacity = $('opacity');
    if (document.activeElement !== opacity) opacity.value = String(st.opacity);
    $('opacity-value').value = `${opacity.value}%`;

    renderAccount(s.account);

    $('version').textContent = `Version ${s.app.version}`;
    $('grid-info').textContent = s.app.grid
      ? `Desktop tile: ${s.app.grid.w} × ${s.app.grid.h} (from ${s.app.grid.source}).`
      : '';
  }

  meter.onSettings(render);
  meter.getSettings().then(render);
})();
