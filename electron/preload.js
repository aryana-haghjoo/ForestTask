'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: d => ipcRenderer.invoke('data:save', d),
    reseed: () => ipcRenderer.invoke('data:reseed'),
    path: () => ipcRenderer.invoke('data:path'),
    reveal: () => ipcRenderer.invoke('data:reveal'),
    exportFile: d => ipcRenderer.invoke('data:export', d),
    importFile: () => ipcRenderer.invoke('data:import')
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: patch => ipcRenderer.invoke('settings:save', patch)
  },
  ai: {
    chat: payload => ipcRenderer.invoke('ai:chat', payload)
  },
  on: (channel, cb) => {
    const allowed = [
      'menu:new-project', 'menu:new-task', 'menu:import',
      'menu:export', 'menu:fit', 'menu:toggle-chat', 'menu:settings'
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, () => cb());
  }
});
