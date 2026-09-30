import type { IpcMain } from 'electron';

type ToolingHandlerDeps = {
  ipcMain: IpcMain;
  sandboxExec: (args: unknown) => unknown;
  panelOpenTab: (url?: string) => unknown;
  panelListTabs: () => unknown;
  panelSetActive: (tabId: string) => unknown;
  panelCloseTab: (tabId?: string) => unknown;
  panelCloseAll: () => unknown;
  panelSetVisible: (visible: boolean) => unknown;
  panelSetOccluded: (occluded: boolean) => unknown;
  panelSetBounds: (rect: unknown) => unknown;
  panelSetViewport: (preset: unknown, tabId?: string) => unknown;
  browserNavigate: (url: string, tabId?: string) => unknown;
  browserSnapshot: (tabId?: string) => unknown;
  browserClick: (text: string, tabId?: string) => unknown;
  browserTypeText: (selector: string, text: string, tabId?: string) => unknown;
  browserEvaluate: (script: string, tabId?: string) => unknown;
  browserScreenshot: (tabId?: string) => unknown;
  browserGetCurrentUrl: (tabId?: string) => unknown;
  browserClose: (tabId?: string) => unknown;
  generatePptx: (data: unknown) => unknown;
  parseSlidesFromMarkdown: (markdown: string) => unknown;
  slidesToMarkdown: (slides: unknown) => unknown;
  generateDocx: (data: unknown) => unknown;
  generateXlsx: (data: unknown) => unknown;
  generatePdf: (data: unknown) => unknown;
};

export function registerToolingHandlers(deps: ToolingHandlerDeps): void {
  deps.ipcMain.handle('sandbox_exec', (_e, args) => deps.sandboxExec(args));

  deps.ipcMain.handle('browser_open_tab', (_e, { url } = {}) => deps.panelOpenTab(url));
  deps.ipcMain.handle('browser_list_tabs', () => deps.panelListTabs());
  deps.ipcMain.handle('browser_set_active', (_e, { tabId }) => deps.panelSetActive(tabId));
  deps.ipcMain.handle('browser_close_tab', (_e, { tabId } = {}) => deps.panelCloseTab(tabId));
  deps.ipcMain.handle('browser_close_all', () => deps.panelCloseAll());
  deps.ipcMain.handle('browser_panel_visible', (_e, { visible }) => deps.panelSetVisible(visible));
  deps.ipcMain.handle('browser_panel_occluded', (_e, { occluded }) => deps.panelSetOccluded(!!occluded));
  deps.ipcMain.handle('browser_panel_bounds', (_e, rect) => deps.panelSetBounds(rect));
  deps.ipcMain.handle('browser_viewport', (_e, { preset, tabId } = {}) => deps.panelSetViewport(preset, tabId));

  deps.ipcMain.handle('browser_navigate', (_e, { url, tabId }) => deps.browserNavigate(url, tabId));
  deps.ipcMain.handle('browser_snapshot', (_e, { tabId } = {}) => deps.browserSnapshot(tabId));
  deps.ipcMain.handle('browser_click', (_e, { text, tabId }) => deps.browserClick(text, tabId));
  deps.ipcMain.handle('browser_type_text', (_e, { selector, text, tabId }) => deps.browserTypeText(selector, text, tabId));
  deps.ipcMain.handle('browser_evaluate', (_e, { script, tabId }) => deps.browserEvaluate(script, tabId));
  deps.ipcMain.handle('browser_screenshot', (_e, { tabId } = {}) => deps.browserScreenshot(tabId));
  deps.ipcMain.handle('browser_get_current_url', (_e, { tabId } = {}) => deps.browserGetCurrentUrl(tabId));
  deps.ipcMain.handle('browser_close', (_e, { tabId } = {}) => deps.browserClose(tabId));

  deps.ipcMain.handle('generate_pptx', (_e, { data }) => deps.generatePptx(data));
  deps.ipcMain.handle('parse_slides_from_markdown', (_e, { markdown }) => deps.parseSlidesFromMarkdown(markdown));
  deps.ipcMain.handle('slides_to_markdown', (_e, { slides }) => deps.slidesToMarkdown(slides));
  deps.ipcMain.handle('generate_docx', (_e, { data }) => deps.generateDocx(data));
  deps.ipcMain.handle('generate_xlsx', (_e, { data }) => deps.generateXlsx(data));
  deps.ipcMain.handle('generate_pdf', (_e, { data }) => deps.generatePdf(data));
}
