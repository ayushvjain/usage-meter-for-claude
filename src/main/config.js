'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { clampRefreshMinutes, DEFAULT_REFRESH_MINUTES } = require('../shared/core');

const DEFAULTS = Object.freeze({
  refreshMinutes: DEFAULT_REFRESH_MINUTES,
  showPeakHours: true,
  alwaysOnTop: true,
  startWithWindows: false,
  warnAt: 60,
  dangerAt: 85,
  position: null, // { x, y } once the user drags the widget
  orgId: null, // organization the user picked when the account has several
});

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function sanitize(input) {
  const s = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
  s.refreshMinutes = clampRefreshMinutes(s.refreshMinutes);
  s.showPeakHours = Boolean(s.showPeakHours);
  s.alwaysOnTop = Boolean(s.alwaysOnTop);
  s.startWithWindows = Boolean(s.startWithWindows);
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

module.exports = { DEFAULTS, load, save, configPath };
