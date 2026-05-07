import type { IpcMain } from 'electron';

type ToolingHandlerDeps = {
  ipcMain: IpcMain;
  sandboxExec: (args: unknown) => unknown;
  browserNavigate: (url: string) => unknown;
  browserSnapshot: () => unknown;
  browserClick: (text: string) => unknown;
  browserTypeText: (selector: string, text: string) => unknown;
  browserEvaluate: (script: string) => unknown;
  browserScreenshot: () => unknown;
  browserGetCurrentUrl: () => unknown;
  browserClose: () => unknown;
  generatePptx: (data: unknown) => unknown;
  savePptx: (data: unknown, path: string) => unknown;
  parseSlidesFromMarkdown: (markdown: string) => unknown;
  slidesToMarkdown: (slides: unknown) => unknown;
  generateDocx: (data: unknown) => unknown;
  generateXlsx: (data: unknown) => unknown;
  generatePdf: (data: unknown) => unknown;
};

export function registerToolingHandlers({
  ipcMain,
  sandboxExec,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserTypeText,
  browserEvaluate,
  browserScreenshot,
  browserGetCurrentUrl,
  browserClose,
  generatePptx,
  savePptx,
  parseSlidesFromMarkdown,
  slidesToMarkdown,
  generateDocx,
  generateXlsx,
  generatePdf,
}: ToolingHandlerDeps): void {
  ipcMain.handle('sandbox_exec', (_e, args) => sandboxExec(args));

  ipcMain.handle('browser_navigate', (_e, { url }) => browserNavigate(url));
  ipcMain.handle('browser_snapshot', () => browserSnapshot());
  ipcMain.handle('browser_click', (_e, { text }) => browserClick(text));
  ipcMain.handle('browser_type_text', (_e, { selector, text }) => browserTypeText(selector, text));
  ipcMain.handle('browser_evaluate', (_e, { script }) => browserEvaluate(script));
  ipcMain.handle('browser_screenshot', () => browserScreenshot());
  ipcMain.handle('browser_get_current_url', () => browserGetCurrentUrl());
  ipcMain.handle('browser_close', () => browserClose());

  ipcMain.handle('generate_pptx', (_e, { data }) => generatePptx(data));
  ipcMain.handle('save_pptx', (_e, { data, path }) => savePptx(data, path));
  ipcMain.handle('parse_slides_from_markdown', (_e, { markdown }) => parseSlidesFromMarkdown(markdown));
  ipcMain.handle('slides_to_markdown', (_e, { slides }) => slidesToMarkdown(slides));
  ipcMain.handle('generate_docx', (_e, { data }) => generateDocx(data));
  ipcMain.handle('generate_xlsx', (_e, { data }) => generateXlsx(data));
  ipcMain.handle('generate_pdf', (_e, { data }) => generatePdf(data));
}
