'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meter', {
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onTheme: (callback) => ipcRenderer.on('theme', (_event, css) => callback(css)),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  chooseOrg: (uuid) => ipcRenderer.invoke('org:choose', uuid),
  openMenu: () => ipcRenderer.send('widget:menu'),
  resize: (height) => ipcRenderer.send('widget:resize', height),
  ready: () => ipcRenderer.send('widget:ready'),
});
