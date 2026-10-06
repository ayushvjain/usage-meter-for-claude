'use strict';

/*
 * Everything that differs between operating systems lives behind this one interface, so
 * main.js never checks which OS it is running on:
 *
 *   name                    'windows' or 'other'
 *   widgetWindowOptions()   extra BrowserWindow options for the widget
 *   pinToDesktop(win)       keep the widget on the desktop, below app windows; returns { detach }
 *   getCell(screen)         size of one desktop icon tile: { w, h, source }
 *   prepareApp(electron)    one-time setup when the app starts
 *   trayIcon(assetsDir)     path to the tray or menu bar icon
 *   loginItem               wording and availability of the "start at login" setting
 */

function load() {
  if (process.platform === 'win32') return require('./windows');
  return require('./fallback');
}

module.exports = load();
