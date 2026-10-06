'use strict';

const path = require('path');
const desktopLayer = require('./desktop-layer');
const desktopGrid = require('./desktop-grid');

module.exports = {
  name: 'windows',

  widgetWindowOptions() {
    return {
      skipTaskbar: true,
      // "toolbar" makes it a tool window: no taskbar button and not listed in Alt+Tab.
      type: 'toolbar',
    };
  },

  pinToDesktop(win) {
    return desktopLayer.attach(win);
  },

  getCell(screen) {
    return desktopGrid.getCell(screen);
  },

  prepareApp() {},

  trayIcon(assetsDir) {
    return path.join(assetsDir, 'tray.png');
  },

  loginItem: {
    label: 'Start with Windows',
    note: 'Open the widget when you sign in to Windows.',
    // Store (MSIX) builds manage startup through Windows Settings instead.
    managedElsewhere: Boolean(process.windowsStore),
    managedNote: 'For the Microsoft Store version, turn this on in Windows Settings > Apps > Startup.',
  },
};
