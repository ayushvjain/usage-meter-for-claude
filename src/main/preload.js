'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Shared by the widget and the Settings window. Each page uses the parts it needs.
contextBridge.exposeInMainWorld('meter', {
  // Widget
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onTheme: (callback) => ipcRenderer.on('theme', (_event, css) => callback(css)),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  openMenu: () => ipcRenderer.send('widget:menu'),
  resize: (height) => ipcRenderer.send('widget:resize', height),
  ready: () => ipcRenderer.send('widget:ready'),

  // Account
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  chooseOrg: (uuid) => ipcRenderer.invoke('org:choose', uuid),

  // Settings window
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  onSettings: (callback) => ipcRenderer.on('settings', (_event, snapshot) => callback(snapshot)),
  action: (name) => ipcRenderer.invoke('app:action', name),
});