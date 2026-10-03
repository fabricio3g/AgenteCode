const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('chatControlsTest', { invoke: (command, args) => ipcRenderer.invoke(command, args) });
