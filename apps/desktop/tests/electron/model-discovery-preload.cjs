const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelListTest', { read: args => ipcRenderer.invoke('fetch_provider_models', args) });
