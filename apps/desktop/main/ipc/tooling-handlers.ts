import type { IpcMain } from 'electron';
import { panelPickElement, panelPickCancel } from '../browser-picker.ts';
import { panelState, panelSetHost, panelSelectScope, withBrowserScope } from '../browser-panel.ts';
import type { BrowserPresentation } from '../../shared/browser-presentation.ts';

type ToolingHandlerDeps = {
  ipcMain: IpcMain;
  panelOpenTab: (url?: string) => unknown;
  panelSetActive: (tabId: string) => unknown;
  panelCloseTab: (tabId?: string) => unknown;
  panelSetVisible: (visible: boolean) => unknown;
  panelSetPresentation: (presentation: BrowserPresentation) => unknown;
  panelSetViewport: (preset: unknown, tabId?: string) => unknown;
  browserNavigate: (url: string, tabId?: string) => unknown;
  browserSnapshot: (tabId?: string) => unknown;
  browserClick: (text: string, tabId?: string) => unknown;
  browserScreenshot: (tabId?: string) => unknown;
  browserClose: (tabId?: string) => unknown;
  generatePptx: (data: unknown) => unknown;
  parseSlidesFromMarkdown: (markdown: string) => unknown;
  generateDocx: (data: unknown) => unknown;
  generateXlsx: (data: unknown) => unknown;
  generatePdf: (data: unknown) => unknown;
};

export function registerToolingHandlers(deps: ToolingHandlerDeps): void {
  deps.ipcMain.handle('browser_get_state', (_e, { scope }) => withBrowserScope(scope, () => panelState(scope)));
  deps.ipcMain.handle('browser_select_scope', (_e, { scope }) => panelSelectScope(scope));
  deps.ipcMain.handle('browser_open_tab', (_e, { url, scope } = {}) => withBrowserScope(scope, () => deps.panelOpenTab(url)));
  deps.ipcMain.handle('browser_set_active', (_e, { tabId, scope }) => withBrowserScope(scope, () => deps.panelSetActive(tabId)));
  deps.ipcMain.handle('browser_close_tab', (_e, { tabId, scope } = {}) => withBrowserScope(scope, () => deps.panelCloseTab(tabId)));
  deps.ipcMain.handle('browser_panel_visible', (_e, { visible, scope }) => withBrowserScope(scope, () => deps.panelSetVisible(visible)));
  deps.ipcMain.handle('browser_panel_presentation', (event, presentation) => withBrowserScope(presentation.scope, () => { if (!panelSetHost(event.sender, presentation.exposed)) return { image: null }; return deps.panelSetPresentation(presentation); }));
  deps.ipcMain.handle('browser_viewport', (_e, { preset, tabId, scope } = {}) => withBrowserScope(scope, () => deps.panelSetViewport(preset, tabId)));

  deps.ipcMain.handle('browser_navigate', (_e, { url, tabId, scope }) => withBrowserScope(scope, () => deps.browserNavigate(url, tabId)));
  deps.ipcMain.handle('browser_snapshot', (_e, { tabId, scope } = {}) => withBrowserScope(scope, () => deps.browserSnapshot(tabId)));
  deps.ipcMain.handle('browser_click', (_e, { text, tabId, scope }) => withBrowserScope(scope, () => deps.browserClick(text, tabId)));
  deps.ipcMain.handle('browser_pick_element', (_e, { tabId, scope, multi } = {}) => withBrowserScope(scope, () => panelPickElement(tabId, !!multi)));
  deps.ipcMain.handle('browser_pick_cancel', (_e, { tabId, scope } = {}) => withBrowserScope(scope, () => panelPickCancel(tabId)));
  deps.ipcMain.handle('browser_screenshot', (_e, { tabId, scope } = {}) => withBrowserScope(scope, () => deps.browserScreenshot(tabId)));
  deps.ipcMain.handle('browser_close', (_e, { tabId, scope } = {}) => withBrowserScope(scope, () => deps.browserClose(tabId)));

  deps.ipcMain.handle('generate_pptx', (_e, { data }) => deps.generatePptx(data));
  deps.ipcMain.handle('parse_slides_from_markdown', (_e, { markdown }) => deps.parseSlidesFromMarkdown(markdown));
  deps.ipcMain.handle('generate_docx', (_e, { data }) => deps.generateDocx(data));
  deps.ipcMain.handle('generate_xlsx', (_e, { data }) => deps.generateXlsx(data));
  deps.ipcMain.handle('generate_pdf', (_e, { data }) => deps.generatePdf(data));
}
