import { app, BrowserWindow, Notification, ipcMain, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../shared/brand.ts';
import type { ActivityNotification } from '../shared/notifications.ts';

const history: ActivityNotification[] = [];
const native = new Set<Notification>();
let openChat: (chatId: string) => void = () => {};
let enabled = true;
function publish() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('activity_notifications', { items: history, enabled });
    }
  }
}
export function notifyActivity(input: Omit<ActivityNotification, 'createdAt' | 'read'>, owner?: WebContents) {
  if (history.some(item => item.id === input.id)) return;
  const item = { ...input, createdAt: Date.now(), read: false };
  history.unshift(item); history.splice(100); publish();
  const win = owner && BrowserWindow.fromWebContents(owner);
  if (!enabled || (win?.isVisible() && win.isFocused()) || !Notification.isSupported()) return;
  try {
    const notification = new Notification({ title: `${APP_NAME} · ${item.title}`, body: item.body, silent: true });
    native.add(notification);
    notification.on('click', () => { item.read = true; publish(); openChat(item.chatId); });
    notification.once('close', () => native.delete(notification));
    notification.once('failed', () => native.delete(notification));
    notification.show();
  } catch (error) { console.warn('[notifications] Desktop delivery unavailable:', error instanceof Error ? error.message : String(error)); }
}
export function registerActivityNotifications(open: (chatId: string) => void) {
  openChat = open;
  try { enabled = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'notifications.json'), 'utf8')).enabled !== false; } catch { /* First launch uses notifications. */ }
  ipcMain.handle('activity_notifications_list', () => ({ items: history, enabled }));
  ipcMain.handle('activity_notifications_action', (_event, args) => notificationAction(args));
}
export function notificationAction(args: { action?: string; id?: string; enabled?: boolean } = {}) {
    if (args.action === 'read') { for (const item of history) if (!args.id || item.id === args.id) item.read = true; }
    else if (args.action === 'clear') history.splice(0);
    else if (args.action === 'enable') {
      enabled = args.enabled !== false;
      const dir = app.getPath('userData'); fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'notifications.json'), JSON.stringify({enabled}));
    }
    else if (args.action === 'open') { const item = history.find(item => item.id === args.id); if (item) { item.read = true; openChat(item.chatId); } }
    else throw new Error('Unknown notification action.');
    publish(); return { items: history, enabled };
}
