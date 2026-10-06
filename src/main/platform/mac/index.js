'use strict';

const path = require('path');
const desktopLayer = require('./desktop-layer');

// Finder's default desktop grid is roughly this size. Reading the user's own Finder grid
// spacing is a later improvement; until then the widget snaps to this grid.
const MAC_DEFAULT_CELL = Object.freeze({ w: 96, h: 96 });

module.exports = {
  name: 'mac',

  widgetWindowOptions() {
    return {
      skipTaskbar: true,
      // A desktop widget shouldn't cast a window shadow onto the wallpaper.
      hasShadow: false,
    };
  },

  pinToDesktop(win) {
    return desktopLayer.attach(win);
  },

  getCell() {
    return { ...MAC_DEFAULT_CELL, source: 'macOS default' };
  },

  prepareApp({ app, Menu }) {
    // A widget, not a regular app: no Dock icon and not in Cmd+Tab.
    if (app.dock) app.dock.hide();
    // Without a menu, Cmd+C and Cmd+V don't work in the sign-in window. The menu bar
    // itself stays hidden because the app has no Dock icon.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  },

  trayIcon(assetsDir) {
    // "Template" in the name tells macOS to tint the icon for light and dark menu bars.
    return path.join(assetsDir, 'trayTemplate.png');
  },

  loginItem: {
    label: 'Open at login',
    note: 'Open the widget when you log in to your Mac.',
    managedElsewhere: false,
    managedNote: '',
  },
};
