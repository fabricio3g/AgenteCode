import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { afterEach, describe, it } from 'node:test';

const tempAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-rust-engine-test-'));

const mockElectronUrl = `data:text/javascript,${encodeURIComponent(`
export const app = { isPackaged: false, getLocale: () => 'en', getPath: () => ${JSON.stringify(tempAppData)}, on: () => {}, once: () => {} };
export const BrowserWindow = { fromWebContents: () => null, getAllWindows: () => [] };
export class WebContentsView {}
export const dialog = {};
export const session = { defaultSession: {} };
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
export const shell = { openExternal: () => {} };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), getAllDisplays: () => [] };
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
export const desktopCapturer = { getSources: async () => [] };
export const powerMonitor = { on: () => {}, off: () => {} };
export const webContents = { fromId: () => null, getAllWebContents: () => [] };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({ isEmpty: () => true }) };
export const safeStorage = { isEncryptionAvailable: () => false };
export const Notification = class { static isSupported() { return false; } };
export const clipboard = {};
export const protocol = { handle: () => {} };
export default { app, BrowserWindow, WebContentsView, dialog, session, ipcMain, shell, screen, nativeTheme, desktopCapturer, powerMonitor, webContents, nativeImage, safeStorage, Notification, clipboard, protocol };
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { shortCircuit: true, url: mockElectronUrl };
    }
    return nextResolve(specifier, context);
  }
});

const { storeImages, turnParams } = await import('../../main/agente/rust-engine.ts');

afterEach(() => {
  for (const entry of fs.readdirSync(tempAppData)) {
    fs.rmSync(path.join(tempAppData, entry), { recursive: true, force: true });
  }
});

describe('rust-engine edge cases', () => {
  it('forwards thinking_level for external CLI drivers and defaults to null when unset', () => {
    const baseChat = {
      sessionId: '00000000-0000-0000-0000-000000000001',
      instanceId: 'claude',
      model: 'claude-sonnet-4-6',
      mode: 'supervised',
      projectRoot: '/work/proj',
      worktree: null,
      systemPrompt: undefined
    };
    const msg = { role: 'user', content: 'hi', attachments: [] };

    const withHigh = turnParams({ ...baseChat, thinkingLevel: 'high' }, { id: 'claude', model: 'claude-sonnet-4-6' }, msg);
    assert.equal(withHigh.thinking_level, 'high');

    const withMax = turnParams({ ...baseChat, thinkingLevel: 'max' }, { id: 'claude', model: 'claude-sonnet-4-6' }, msg);
    assert.equal(withMax.thinking_level, 'max');

    const unset = turnParams({ ...baseChat, thinkingLevel: undefined }, { id: 'claude', model: 'claude-sonnet-4-6' }, msg);
    assert.equal(unset.thinking_level, null);
  });

  it('storeImages fails closed without writing to appData when media.import rejects or returns nothing', async () => {
    const rejectingClient = {
      async request() {
        throw new Error('media kind blocked by policy');
      }
    };
    await assert.rejects(
      () => storeImages(rejectingClient, [{ data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' }]),
      /media kind blocked by policy/
    );

    const emptyClient = {
      async request() {
        return {};
      }
    };
    await assert.rejects(
      () => storeImages(emptyClient, [{ data: Buffer.from('abc').toString('base64'), mimeType: 'image/png' }]),
      /Image import failed/
    );

    assert.equal(fs.existsSync(path.join(tempAppData, 'agente', 'attachments')), false);
  });
});
