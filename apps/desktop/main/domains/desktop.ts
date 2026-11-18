import path from 'node:path';
import fs from 'node:fs';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { getAppPaths } from '../paths.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { DomainService } from './service.ts';
import type { DomainConfig } from '../../shared/domains.ts';
import { DOMAIN_TOOL_DEFS } from '../../shared/domains.ts';
import type { AgentTool } from '../../shared/agent-core/types.ts';

let instance: DomainService | undefined;
function domainConfig(): DomainConfig {
  const raw = loadConfig().domains as Partial<DomainConfig> | undefined;
  return { enabled: raw?.enabled ?? {}, runtimes: raw?.runtimes ?? {} };
}
export function domainService(): DomainService {
  return instance ??= new DomainService({ root: path.join(getAppPaths().appData, 'domains'), config: domainConfig,
    resolveBinary: id => { if (id !== 'audio-engine') return undefined; const name = process.platform === 'win32' ? 'agente-audio.exe' : 'agente-audio'; const candidates = [path.join(getAppPaths().nativeBinRoot, name), path.resolve(getAppPaths().projectRoot, '../../target/debug', name)]; return candidates.find(candidate => fs.existsSync(candidate)); },
    emit: job => { for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('domain_job', job); }
  });
}
export function createDomainTools(): AgentTool[] {
  return DOMAIN_TOOL_DEFS.map(def => ({ ...def, mutating: def.name === 'domain_write', executionMode: def.name === 'domain_write' ? 'sequential' : 'parallel', async execute(_id, args, context) {
    try { const result = await domainService().tool(def.name, args, context.sessionId || context.browserScope || 'desktop', context.signal, (context as { workspaceRoot?: string }).workspaceRoot); return { content: JSON.stringify(result), details: result }; }
    catch (error) { return { content: (error as Error).message, isError: true }; }
  } }));
}
export function registerDomainHandlers(): void {
  ipcMain.handle('domains_status', () => domainService().status());
  ipcMain.handle('domains_set_enabled', (_event, { domain, enabled }) => {
    domainService().registry.get(domain);
    const config = loadConfig(); const domains = domainConfig(); domains.enabled[domain] = enabled === true;
    saveConfig({ ...config, domains }); return domainService().status();
  });
  ipcMain.handle('domains_pick_runtime', async (_event, { dependency }) => {
    if (!domainService().registry.list().some(p => p.dependencies.some(d => d.id === dependency))) throw new Error('Unknown domain dependency');
    const selected = await dialog.showOpenDialog({ title: `Choose ${dependency} executable`, properties: ['openFile'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const config = loadConfig(); const domains = domainConfig(); domains.runtimes[dependency] = selected.filePaths[0]; saveConfig({ ...config, domains }); return domainService().status();
  });
  ipcMain.handle('domains_projects', () => domainService().store.list());
  ipcMain.handle('domains_project', (_event, { projectId }) => domainService().store.read(projectId));
  ipcMain.handle('domains_import', (_event, { name, bytes, kind }) => domainService().importBytes(String(name), new Uint8Array(bytes), kind));
  ipcMain.handle('domains_preview', (_event, { assetId }) => domainService().preview(assetId));
  ipcMain.handle('domains_jobs', () => domainService().jobs.list());
  ipcMain.handle('domains_cancel', (event, { owner, jobId }) => { if (jobId) domainService().jobs.cancel(jobId); else domainService().jobs.cancelOwner(owner || `window:${event.sender.id}`); });
  ipcMain.handle('domains_call', async (event, { name, args, owner, workspaceRoot }) => {
    // Workspace access from agent calls is supplied by the owning transport, never by model arguments.
    const controller = new AbortController(); const scope = owner || `window:${event.sender.id}`;
    const disconnect = () => controller.abort(); event.sender.once('destroyed', disconnect);
    try { return await domainService().tool(name, args, scope, controller.signal, workspaceRoot); }
    finally { event.sender.removeListener('destroyed', disconnect); }
  });
}
