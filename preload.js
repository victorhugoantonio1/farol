'use strict';
// Ponte mínima entre a interface e o processo principal.
// A interface não tem acesso a Node, só a estas funções.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topwatch', {
  // ilha
  setInteractive: (on) => ipcRenderer.send('island:interactive', !!on),
  getState: () => ipcRenderer.invoke('island:state'),
  refresh: () => ipcRenderer.send('island:refresh'),
  openSettings: () => ipcRenderer.send('island:settings'),
  unpin: () => ipcRenderer.send('island:unpin'),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  acknowledge: (itemId) => ipcRenderer.invoke('zabbix:ack', itemId),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onPinned: (fn) => ipcRenderer.on('pinned', (_e, p) => fn(p)),
  onAlert: (fn) => ipcRenderer.on('alert', () => fn()),

  // configurações
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (changes) => ipcRenderer.invoke('settings:save', changes),
  testConnection: (which, changes, serverId) => ipcRenderer.invoke('settings:test', which, changes, serverId),
});
