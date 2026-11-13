import en from '../../renderer/src/lib/locales/en.json';
import es from '../../renderer/src/lib/locales/es.json';
import pt from '../../renderer/src/lib/locales/pt-BR.json';
import zh from '../../renderer/src/lib/locales/zh.json';
import fr from '../../renderer/src/lib/locales/fr.json';
import de from '../../renderer/src/lib/locales/de.json';
import ja from '../../renderer/src/lib/locales/ja.json';
import type { AgenteTransport } from './transport.ts';
import { launchConfigFromSaved } from '../../shared/local-launch.ts';

const catalogs = { en, es, 'pt-BR': pt, zh, fr, de, ja };

export class RuntimeNoModelError extends Error {
  readonly errorKey: string;

  constructor(locale = 'en', local = false) {
    const language = locale.toLowerCase().split(/[-_]/)[0];
    const key = language === 'pt' ? 'pt-BR' : language;
    const messageKey = local ? 'runtimeLocalModelNotRunning' : 'runtimeNoModel';
    super((catalogs[key as keyof typeof catalogs] ?? en).code[messageKey]);
    this.errorKey = `code.${messageKey}`;
    this.name = 'RuntimeNoModelError';
  }
}

type LocalConfig = Record<string, any>;
type PreflightDeps = {
  localConfig: () => LocalConfig;
  status: () => Record<string, unknown>;
  pendingLaunch: () => { config: Record<string, unknown>; promise: Promise<unknown> } | null;
  start: (config: Record<string, unknown>) => Promise<unknown>;
  locale: () => string;
};

function matchesLaunch(config: Record<string, unknown>, port: number, selectedPath: string): boolean {
  return Number(config.port || 11435) === port && (!selectedPath || config.model_path === selectedPath);
}

/**
 * The agent's auto-start: the selected model with its saved settings, through
 * the same mapping as every other load (shared/local-launch.ts). It used to
 * start from main's recommendation — an 8k context on 16 GB machines, GPU
 * layers from a VRAM probe that misses integrated GPUs, and memory locking.
 */
async function loadSelectedModel(deps: PreflightDeps, local: LocalConfig, selectedPath: string, port: number): Promise<void> {
  await deps.start({ ...launchConfigFromSaved(local, selectedPath), port });
}

async function existingLaunch(deps: PreflightDeps, port: number, selectedPath: string): Promise<boolean> {
  const status = deps.status();
  if (status.state === 'ready' && matchesLaunch(status, port, selectedPath)) return true;
  const launch = deps.pendingLaunch();
  if (!launch) return false;
  return awaitMatchingLaunch(launch, port, selectedPath);
}

async function awaitMatchingLaunch(launch: { config: Record<string, unknown>; promise: Promise<unknown> }, port: number, selectedPath: string): Promise<boolean> {
  if (!matchesLaunch(launch.config, port, selectedPath)) return false;
  await launch.promise;
  return true;
}

function localSelection(local: LocalConfig, baseUrl: string): { port: number; selectedPath: string } {
  const url = new URL(baseUrl);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return { port, selectedPath: String(local.selected_model_path || '').trim() };
}

/** Share Home's managed launch, including its readiness promise, before any model RPC. */
export function createProviderPreflight(deps: PreflightDeps): (transport: AgenteTransport) => Promise<void> {
  let pending: { key: string; promise: Promise<void> } | null = null;
  function clearPending(request: typeof pending): void {
    if (pending === request) pending = null;
  }
  async function loadConfiguredModel(local: LocalConfig, transport: AgenteTransport, selectedPath: string, port: number): Promise<void> {
    if (!selectedPath) throw new RuntimeNoModelError(deps.locale(), true);
    const key = JSON.stringify([selectedPath, transport.baseUrl, local]);
    if (pending?.key === key) return pending.promise;
    const promise = loadSelectedModel(deps, local, selectedPath, port);
    const request = { key, promise };
    pending = request;
    try { await promise; }
    finally { clearPending(request); }
  }
  async function ensureLocal(transport: AgenteTransport): Promise<void> {
    // The saved settings stay as saved: they name the file they were chosen
    // for, so a conversation pinned to another file starts that one on auto
    // instead of inheriting this one's context and GPU layers.
    const saved = deps.localConfig();
    const local = { ...saved, ...(transport.modelPath !== undefined ? { selected_model_path: transport.modelPath } : {}) };
    const { port, selectedPath } = localSelection(local, transport.baseUrl);
    // A Home load may still be preparing the model. Await its exact launch
    // rather than replacing it midway through.
    if (await existingLaunch(deps, port, selectedPath)) return;
    await loadConfiguredModel(saved, transport, selectedPath, port);
  }
  return async (transport) => {
    if (transport.providerName === 'local') return ensureLocal(transport);
    if (!transport.model.trim()) throw new RuntimeNoModelError(deps.locale());
  };
}
