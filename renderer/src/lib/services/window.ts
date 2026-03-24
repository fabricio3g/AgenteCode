// Electron window controls – replaces Tauri window API

import { isElectron } from './tauri';

export const appWindow = {
  async minimize() {
    if (!isElectron()) return;
    await window.electronAPI!.windowMinimize();
  },
  async toggleMaximize() {
    if (!isElectron()) return;
    await window.electronAPI!.windowToggleMaximize();
  },
  async isMaximized(): Promise<boolean> {
    if (!isElectron()) return false;
    return window.electronAPI!.windowIsMaximized();
  },
  async close() {
    if (!isElectron()) return;
    await window.electronAPI!.windowClose();
  }
};
