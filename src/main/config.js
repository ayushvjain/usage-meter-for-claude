'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { clampRefreshMinutes, DEFAULT_REFRESH_MINUTES, STYLES, THEMES, ACCENTS, OPACITY_RANGE, clampScale } = require('../shared/core');

const DEFAULTS = Object.freeze({
  refreshMinutes: DEFAULT_REFRESH_MINUTES,
  showPeakHours: true,
  startWithWindows: false,
  style: 'cozy', // cozy (warm colours, serif numbers) or classic
  theme: 'system', // system, dark or light
  accent: 'clay', // bar and button colour
  opacity: 90, // panel background opacity in percent
  scale: 1, // widget size: 1 is 100%; dragging the corner or Settings changes it
  warnAt: 60,
  dangerAt: 85,
  position: null, // { x, y } of the widget's top-left tile once placed
  orgId: null, // organization the user picked when the account has several
});

// Settings from older versions that no longer exist. The widget now sizes itself.
const RETIRED = ['alwaysOnTop', 'widgetSize'];

// Settings the Settings window may change, with how to clean each value.
const EDITABLE = {
  refreshMinutes: (v) => clampRefreshMinutes(v),
  showPeakHours: (v) => Boolean(v),
  startWithWindows: (v) => Boolean(v),
  style: (v) => (STYLES.includes(v) ? v : DEFAULTS.style),
  theme: (v) => (THEMES.includes(v) ? v : DEFAULTS.theme),
  accent: (v) => (ACCENTS.includes(v) ? v : DEFAULTS.accent),
  scale: (v) => clampScale(v),
  opacity: (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(OPACITY_RANGE.max, Math.max(OPACITY_RANGE.min, n)) : DEFAULTS.opacity;
  },
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function sanitize(input) {
  const s = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
  RETIRED.forEach((key) => delete s[key]);
  for (const [key, clean] of Object.entries(EDITABLE)) s[key] = clean(s[key]);
  s.warnAt = Number.isFinite(Number(s.warnAt)) ? Number(s.warnAt) : DEFAULTS.warnAt;
  s.dangerAt = Number.isFinite(Number(s.dangerAt)) ? Number(s.dangerAt) : DEFAULTS.dangerAt;
  if (typeof s.orgId !== 'string' || !s.orgId) s.orgId = null;
  if (!s.position || !Number.isFinite(s.position.x) || !Number.isFinite(s.position.y)) s.position = null;
  return s;
}

function load() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return sanitize(null);
  }
}

function save(settings) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sanitize(settings), null, 2));
  fs.renameSync(tmp, file);
}

/** Cleans one value from the Settings window. Returns undefined for keys it may not change. */
function cleanEditable(key, value) {
  return Object.prototype.hasOwnProperty.call(EDITABLE, key) ? EDITABLE[key](value) : undefined;
}

module.exports = { DEFAULTS, load, save, configPath, cleanEditable };
