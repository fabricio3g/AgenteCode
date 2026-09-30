import en from '../../renderer/src/lib/locales/en.json';
import es from '../../renderer/src/lib/locales/es.json';
import pt from '../../renderer/src/lib/locales/pt-BR.json';
import zh from '../../renderer/src/lib/locales/zh.json';
import fr from '../../renderer/src/lib/locales/fr.json';
import de from '../../renderer/src/lib/locales/de.json';
import ja from '../../renderer/src/lib/locales/ja.json';
import type { AgenteTransport } from './transport.ts';

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
  recommended: (modelPath: string, context: unknown, gpu: unknown, runtime: string) => Promise<Record<string, any>>;
  start: (config: Record<string, unknown>) => Promise<unknown>;
  locale: () => string;
};

function matchesLaunch(config: Record<string, unknown>, port: number, selectedPath: string): boolean {
  return Number(config.port || 11435) === port && (!selectedPath || config.model_path === selectedPath);
}

async function loadSelectedModel(deps: PreflightDeps, local: LocalConfig, selectedPath: string, port: number): Promise<void> {
  const settings = await deps.recommended(selectedPath, local.context_length, local.gpu_layers, local.runtime_path || '');
  await deps.start({
    model_path: selectedPath,
    backend_mode: settings.backend,
    host: '127.0.0.1',
    port,
    context_length: settings.context_length,
    gpu_offload: settings.gpu_layers,
    batch_size: settings.batch_size,
    cpu_threads: settings.cpu_threads,
    flash_attention: settings.flash_attention,
    offload_kv_cache: settings.offload_kv,
    mmap: settings.use_mmap,
    keep_in_memory: true,
    runtime_path: local.runtime_path,
    mmproj_path: local.mmproj_path
  });
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
    const local = deps.localConfig();
    const { port, selectedPath } = localSelection(local, transport.baseUrl);
    // A Home load may still be preparing the model. Await its exact launch
    // rather than replacing it with recommended defaults midway through.
    if (await existingLaunch(deps, port, selectedPath)) return;
    await loadConfiguredModel(local, transport, selectedPath, port);
  }
  return async (transport) => {
    if (transport.providerName === 'local') return ensureLocal(transport);
    if (!transport.model.trim()) throw new RuntimeNoModelError(deps.locale());
  };
}
