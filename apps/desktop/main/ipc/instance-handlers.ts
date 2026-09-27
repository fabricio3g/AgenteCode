import { BrowserWindow, type IpcMain } from 'electron';
import { getMainWindow } from '../window-manager.ts';
import {
  instanceKey, lanAddress, listInstances, setInstanceNotifier, setInstanceSharing, startInstance, stopInstance,
  type StartInstanceOptions
} from '../instances.ts';

/** Running local models: list, start more, stop, share on the network. */
export function registerInstanceHandlers(ipcMain: IpcMain): void {
  setInstanceNotifier(getMainWindow);
  ipcMain.handle('list_instances', () => ({ instances: listInstances(), lan_address: lanAddress() }));
  ipcMain.handle('start_instance', (_e, args: StartInstanceOptions) => startInstance(args));
  ipcMain.handle('stop_instance', (e, args: { id: string }) => stopInstance(String(args?.id || ''), BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('set_instance_sharing', (e, args: { id: string; share: boolean }) =>
    setInstanceSharing(String(args?.id || ''), !!args?.share, BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('get_instance_key', (_e, args: { id: string }) => instanceKey(String(args?.id || '')));
}
