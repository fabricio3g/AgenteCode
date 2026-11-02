const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('computerOverlay', {
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('computer_overlay_state', handler);
    return () => ipcRenderer.removeListener('computer_overlay_state', handler);
  },
  ready: () => ipcRenderer.invoke('computer_overlay_ready'),
  control: action => ['takeover', 'resume', 'end'].includes(action)
    ? ipcRenderer.invoke('computer_control', { action })
    : Promise.reject(new Error('Unknown computer control')),
});
