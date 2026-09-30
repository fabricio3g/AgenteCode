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

export function registerToolingHandlers({
  ipcMain,
  sandboxExec,
  panelOpenTab,
  panelListTabs,
  panelSetActive,
  panelCloseTab,
  panelCloseAll,
  panelSetVisible,
  panelSetOccluded,
  panelSetBounds,
  panelSetViewport,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserTypeText,
  browserEvaluate,
  browserScreenshot,
  browserGetCurrentUrl,
  browserClose,
  generatePptx,
  parseSlidesFromMarkdown,
  slidesToMarkdown,
  generateDocx,
  generateXlsx,
  generatePdf,
}: ToolingHandlerDeps): void {
  ipcMain.handle('sandbox_exec', (_e, args) => sandboxExec(args));

  ipcMain.handle('browser_open_tab', (_e, { url } = {}) => panelOpenTab(url));
  ipcMain.handle('browser_list_tabs', () => panelListTabs());
  ipcMain.handle('browser_set_active', (_e, { tabId }) => panelSetActive(tabId));
  ipcMain.handle('browser_close_tab', (_e, { tabId } = {}) => panelCloseTab(tabId));
  ipcMain.handle('browser_close_all', () => panelCloseAll());
  ipcMain.handle('browser_panel_visible', (_e, { visible }) => panelSetVisible(visible));
  ipcMain.handle('browser_panel_occluded', (_e, { occluded }) => panelSetOccluded(!!occluded));
  ipcMain.handle('browser_panel_bounds', (_e, rect) => panelSetBounds(rect));
  ipcMain.handle('browser_viewport', (_e, { preset, tabId } = {}) => panelSetViewport(preset, tabId));

  ipcMain.handle('browser_navigate', (_e, { url, tabId }) => browserNavigate(url, tabId));
  ipcMain.handle('browser_snapshot', (_e, { tabId } = {}) => browserSnapshot(tabId));
  ipcMain.handle('browser_click', (_e, { text, tabId }) => browserClick(text, tabId));
  ipcMain.handle('browser_type_text', (_e, { selector, text, tabId }) => browserTypeText(selector, text, tabId));
  ipcMain.handle('browser_evaluate', (_e, { script, tabId }) => browserEvaluate(script, tabId));
  ipcMain.handle('browser_screenshot', (_e, { tabId } = {}) => browserScreenshot(tabId));
  ipcMain.handle('browser_get_current_url', (_e, { tabId } = {}) => browserGetCurrentUrl(tabId));
  ipcMain.handle('browser_close', (_e, { tabId } = {}) => browserClose(tabId));

  ipcMain.handle('generate_pptx', (_e, { data }) => generatePptx(data));
  ipcMain.handle('parse_slides_from_markdown', (_e, { markdown }) => parseSlidesFromMarkdown(markdown));
  ipcMain.handle('slides_to_markdown', (_e, { slides }) => slidesToMarkdown(slides));
  ipcMain.handle('generate_docx', (_e, { data }) => generateDocx(data));
  ipcMain.handle('generate_xlsx', (_e, { data }) => generateXlsx(data));
  ipcMain.handle('generate_pdf', (_e, { data }) => generatePdf(data));
}
