// Electron window controls.

import { isElectron } from './bridge';
import { flushChatSaves } from '$lib/utils/storage';

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
    await flushChatSaves();
    if (window.electronAPI?.windowRequestClose) {
      await window.electronAPI.windowRequestClose();
      return;
    }
    await window.electronAPI!.windowClose();
  },
  /**
   * Repaint the OS caption buttons (Windows/Linux). The overlay is coloured
   * once when the window is created, so the theme has to push new colours or
   * the buttons keep the old theme and the window visibly pops out of place.
   * Also updates the backing window; macOS keeps its native traffic lights.
   */
  async setTitlebarOverlay(overlay: { color: string; symbolColor: string }): Promise<boolean> {
    if (!isElectron()) return false;
    return (await window.electronAPI?.windowSetTitlebarOverlay?.(overlay)) ?? false;
  }
};
