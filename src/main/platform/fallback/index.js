'use strict';

/*
 * Used on operating systems without a desktop-widget implementation yet. The widget works
 * as a normal frameless window: it shows usage, but doesn't stay behind other windows or
 * read the desktop icon grid.
 */

const path = require('path');
const { FALLBACK_CELL } = require('../../../shared/core');

module.exports = {
  name: 'other',

  widgetWindowOptions() {
    return { skipTaskbar: true };
  },

  pinToDesktop() {
    return { supported: false, detach() {} };
  },

  getCell() {
    return { ...FALLBACK_CELL, source: 'default' };
  },

  prepareApp() {},

  trayIcon(assetsDir) {
    return path.join(assetsDir, 'tray.png');
  },

  loginItem: {
    label: 'Start at login',
    note: 'Open the widget when you sign in.',
    managedElsewhere: false,
    managedNote: '',
  },
};
