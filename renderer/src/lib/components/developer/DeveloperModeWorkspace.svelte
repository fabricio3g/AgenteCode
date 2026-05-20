<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Code2, Globe2, Play, RefreshCw, Search, Server, Square, Terminal, Trash2 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import {
    buildDeveloperModelMetadataLine,
    createDeveloperConsoleEntry,
    developerModelMatchesSearch,
    parseDeveloperApiInfo,
    replaceDeveloperApiHost,
    type DeveloperConsoleEntry
  } from '$lib/utils/developer-mode';
  import { buildLocalModelOption } from '$lib/utils/local-models';
  import type { ModelOption } from '$lib/types/chat';

  let search = $state('');
  let selectedModelId = $state('');
  let consoleEntries = $state<DeveloperConsoleEntry[]>([]);
  let requestPath = $state('/models');
  let requestBody = $state(`{
  "model": "local-model",
  "messages": [
    { "role": "user", "content": "Hello from Developer Mode" }
  ],
  "temperature": 0.7,
  "stream": false
}`);
  let sendingRequest = $state(false);
  let actionRunning = $state<'load' | 'unload' | 'share' | null>(null);

  const localModels: ModelOption[] = $derived(modelsStore.availableModels.map((model) => buildLocalModelOption(model)));
  const filteredModels = $derived(localModels.filter((model) => developerModelMatchesSearch(model, search)));
  const selectedModel = $derived(localModels.find((model) => model.id === selectedModelId) || filteredModels[0] || null);
  const baseUrl = $derived(appStore.config.llm?.local?.base_url || 'http://127.0.0.1:11435/v1');
  const apiInfo = $derived(parseDeveloperApiInfo(baseUrl));
  const requestMethod = $derived(requestPath === '/models' ? 'GET' : 'POST');
  const requestUrl = $derived(`${apiInfo.clientApiRoot}${requestPath}`);
  const activeModelName = $derived(appStore.localModelActive?.name || modelsStore.activeModelName || appStore.config.llm?.local?.model || 'No model loaded');
  const activeModelPath = $derived(appStore.localModelActive?.path || modelsStore.status?.active_model || appStore.config.llm?.local?.selected_model_path || '');
  const runtimeState = $derived(modelsStore.statusLabel);
  const runtimePort = $derived(modelsStore.activePort || apiInfo.port);
  const isLanShared = $derived(apiInfo.host === '0.0.0.0');

  function addConsoleEntry(method: string, path: string, status: number, request: unknown, response: unknown, startedAt = Date.now()) {
    const entry = createDeveloperConsoleEntry({
      method,
      path,
      status,
      request,
      response,
      startedAt,
      endedAt: Date.now()
    });
    consoleEntries = [entry, ...consoleEntries].slice(0, 40);
  }

  async function refreshRuntimeStatus() {
    const startedAt = Date.now();
    await modelsStore.refreshStatus();
    addConsoleEntry('GET', '/runtime/status', 200, {}, {
      state: modelsStore.status?.state || null,
      active_model: modelsStore.status?.active_model || null,
      port: modelsStore.status?.port || null,
      sessions_count: modelsStore.status?.sessions_count ?? null
    }, startedAt);
  }

  async function openLoadDialog() {
    if (!selectedModel) return;
    actionRunning = 'load';
    const startedAt = Date.now();
    try {
      await appStore.openLocalModelLoadDialog(selectedModel);
      addConsoleEntry('POST', '/runtime/load-dialog', 202, {
        model: selectedModel.name,
        path: selectedModel.path
      }, {
        ok: true,
        status: 'load dialog opened'
      }, startedAt);
    } catch (error) {
      addConsoleEntry('POST', '/runtime/load-dialog', 500, {
        model: selectedModel.name,
        path: selectedModel.path
      }, {
        ok: false,
        error: String((error as Error)?.message || error)
      }, startedAt);
    } finally {
      actionRunning = null;
    }
  }

  async function unloadChatModel() {
    actionRunning = 'unload';
    const startedAt = Date.now();
    const previous = activeModelName;
    try {
      await appStore.stopLocalModel();
      addConsoleEntry('POST', '/runtime/unload', 200, { model: previous }, { ok: true }, startedAt);
    } catch (error) {
      addConsoleEntry('POST', '/runtime/unload', 500, { model: previous }, {
        ok: false,
        error: String((error as Error)?.message || error)
      }, startedAt);
    } finally {
      actionRunning = null;
    }
  }

  async function setLanSharing(shared: boolean) {
    actionRunning = 'share';
    const startedAt = Date.now();
    const nextBaseUrl = replaceDeveloperApiHost(baseUrl, shared ? '0.0.0.0' : '127.0.0.1');
    try {
      await appStore.updateLocalSettings({ base_url: nextBaseUrl });
      addConsoleEntry('PATCH', '/runtime/base-url', 200, {
        previous: baseUrl,
        next: nextBaseUrl,
        lan_shared: shared
      }, {
        ok: true,
        restart_required: !!activeModelPath
      }, startedAt);
    } catch (error) {
      addConsoleEntry('PATCH', '/runtime/base-url', 500, {
        previous: baseUrl,
        next: nextBaseUrl,
        lan_shared: shared
      }, {
        ok: false,
        error: String((error as Error)?.message || error)
      }, startedAt);
    } finally {
      actionRunning = null;
    }
  }

  async function sendHttpRequest() {
    sendingRequest = true;
    const startedAt = Date.now();
    let parsed: unknown = {};
    if (requestMethod !== 'GET') {
      try {
        parsed = JSON.parse(requestBody);
      } catch {
        parsed = requestBody;
      }
    }

    try {
      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: requestMethod === 'GET' ? undefined : { 'Content-Type': 'application/json' },
        body: requestMethod === 'GET' ? undefined : (typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Plain-text responses are still useful in the console.
      }
      addConsoleEntry(requestMethod, requestPath, response.status, requestMethod === 'GET' ? {} : parsed, body, startedAt);
    } catch (error) {
      addConsoleEntry(requestMethod, requestPath, 0, requestMethod === 'GET' ? {} : parsed, {
        ok: false,
        error: String((error as Error)?.message || error)
      }, startedAt);
    } finally {
      sendingRequest = false;
    }
  }

  function clearConsole() {
    consoleEntries = [];
  }

  onMount(() => {
    if (!modelsStore.availableModels.length) {
      void modelsStore.refresh();
    } else {
      void modelsStore.refreshStatus();
    }
  });
</script>

<section class="developer-panel flex min-h-0 flex-1 overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)]">
  <div class="grid min-h-0 flex-1 grid-cols-[260px_minmax(380px,1fr)_380px] overflow-hidden">
    <aside class="min-h-0 border-r border-[var(--border)]">
      <div class="border-b border-[var(--border)] px-4 py-3">
        <div class="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
          <Code2 class="h-4 w-4" />
          Developer Mode
        </div>
        <div class="mt-1 text-[12px] text-[var(--text-tertiary)]">Local chat runtime</div>
      </div>

      <div class="border-b border-[var(--border)] p-3">
        <label class="relative block">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            bind:value={search}
            class="field pl-8"
            placeholder="Search local models"
          />
        </label>
      </div>

      <div class="model-list min-h-0 overflow-y-auto p-2">
        {#if filteredModels.length}
          {#each filteredModels as model (model.id)}
            <button
              class={`model-row w-full rounded-md px-2.5 py-2 text-left transition ${selectedModel?.id === model.id ? 'is-active' : ''}`}
              onclick={() => (selectedModelId = model.id)}
            >
              <div class="truncate text-[13px] font-medium text-[var(--text)]">{model.name}</div>
              <div class="mt-0.5 truncate text-[12px] text-[var(--text-tertiary)]">{buildDeveloperModelMetadataLine(model) || 'Local GGUF model'}</div>
            </button>
          {/each}
        {:else}
          <div class="px-2 py-8 text-center text-[13px] text-[var(--text-tertiary)]">No local models found</div>
        {/if}
      </div>
    </aside>

    <main class="min-h-0 overflow-y-auto px-5 py-4">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 class="text-[15px] font-semibold leading-6 text-[var(--text)]">Chat model runtime</h2>
          <p class="text-[12px] text-[var(--text-tertiary)]">Controls the same local model used by chat.</p>
        </div>
        <button class="secondary-btn" onclick={refreshRuntimeStatus}>
          <RefreshCw class="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <section class="runtime-card rounded-lg border border-[var(--border)] p-4">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
              <Server class="h-4 w-4 text-[var(--text-secondary)]" />
              <span class="truncate">{activeModelName}</span>
            </div>
            <div class="mt-1 truncate text-[12px] text-[var(--text-tertiary)]">{activeModelPath || 'Select a model and load it for chat'}</div>
          </div>
          <div class="status-text text-[12px] text-[var(--text-secondary)]">{runtimeState}</div>
        </div>

        <div class="grid gap-3 md:grid-cols-4">
          <div>
            <div class="meta-label">Host</div>
            <div class="meta-value">{apiInfo.host}</div>
          </div>
          <div>
            <div class="meta-label">Port</div>
            <div class="meta-value">{runtimePort}</div>
          </div>
          <div>
            <div class="meta-label">Sessions</div>
            <div class="meta-value">{modelsStore.status?.sessions_count ?? 0}</div>
          </div>
          <div>
            <div class="meta-label">Memory</div>
            <div class="meta-value">{modelsStore.status?.memory_mb ? `${modelsStore.status.memory_mb} MB` : 'n/a'}</div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button class="primary-btn" onclick={openLoadDialog} disabled={!selectedModel || actionRunning !== null}>
            <Play class="h-3.5 w-3.5" />
            Load selected
          </button>
          <button class="secondary-btn" onclick={unloadChatModel} disabled={!activeModelPath || actionRunning !== null}>
            <Square class="h-3.5 w-3.5" />
            Unload
          </button>
        </div>
      </section>

      <section class="mt-4 rounded-lg border border-[var(--border)] p-4">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
              <Globe2 class="h-4 w-4 text-[var(--text-secondary)]" />
              API access
            </div>
            <div class="mt-1 text-[12px] text-[var(--text-tertiary)]">{apiInfo.clientApiRoot}</div>
          </div>
          <label class="toggle-row">
            <input
              type="checkbox"
              checked={isLanShared}
              disabled={actionRunning !== null}
              onchange={(event) => setLanSharing((event.currentTarget as HTMLInputElement).checked)}
            />
            <span>LAN</span>
          </label>
        </div>

        <div class="space-y-2 text-[12px] text-[var(--text-secondary)]">
          <div class="endpoint-row"><span>Models</span><code>{apiInfo.clientApiRoot}/models</code></div>
          <div class="endpoint-row"><span>Chat</span><code>{apiInfo.clientApiRoot}/chat/completions</code></div>
          <div class="endpoint-row"><span>Bind</span><code>{apiInfo.apiRoot}</code></div>
          <div class="endpoint-row"><span>LAN URL</span><code>{apiInfo.shareableBaseUrl}</code></div>
        </div>

        {#if activeModelPath}
          <div class="mt-3 text-[12px] text-[var(--text-tertiary)]">Changing LAN mode updates config. Reload the model for the bind address to take effect.</div>
        {/if}
      </section>
    </main>

    <aside class="flex min-h-0 flex-col border-l border-[var(--border)]">
      <div class="border-b border-[var(--border)] px-4 py-3">
        <div class="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
          <Terminal class="h-4 w-4" />
          Console
        </div>
        <div class="mt-1 truncate text-[12px] text-[var(--text-tertiary)]">{requestUrl}</div>
      </div>

      <div class="space-y-3 border-b border-[var(--border)] p-3">
        <select bind:value={requestPath} class="field">
          <option value="/models">GET /v1/models</option>
          <option value="/chat/completions">POST /v1/chat/completions</option>
          <option value="/embeddings">POST /v1/embeddings</option>
        </select>
        <textarea bind:value={requestBody} class="request-body min-h-40 w-full rounded-md border border-[var(--border)] bg-[var(--surface-hover)] p-3 font-mono text-[12px] leading-5 text-[var(--text)] outline-none focus:border-[var(--border-hover)]"></textarea>
        <button class="primary-btn w-full justify-center" onclick={sendHttpRequest} disabled={sendingRequest}>
          {sendingRequest ? 'Sending...' : 'Send request'}
        </button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <div class="text-[12px] font-semibold uppercase text-[var(--text-tertiary)]">Request / response</div>
          <button class="icon-btn" title="Clear console" onclick={clearConsole}><Trash2 class="h-3.5 w-3.5" /></button>
        </div>
        <div class="console-list min-h-0 flex-1 overflow-y-auto p-3">
          {#if consoleEntries.length}
            {#each consoleEntries as entry (entry.id)}
              <details class="console-entry rounded-md border border-[var(--border)] px-3 py-2" open={consoleEntries[0]?.id === entry.id}>
                <summary class="cursor-pointer list-none text-[12px] text-[var(--text-secondary)]">
                  <span class="font-mono text-[var(--text)]">{entry.method}</span>
                  <span>{entry.path}</span>
                  <span class="float-right text-[var(--text-tertiary)]">{entry.status} / {entry.timingMs}ms</span>
                </summary>
                <div class="mt-2 space-y-2">
                  <pre class="console-code">{entry.request}</pre>
                  <pre class="console-code">{entry.response}</pre>
                </div>
              </details>
            {/each}
          {:else}
            <div class="py-8 text-center text-[13px] text-[var(--text-tertiary)]">No requests yet</div>
          {/if}
        </div>
      </div>
    </aside>
  </div>
</section>

<style>
  .developer-panel {
    min-width: 0;
  }

  .model-row {
    border: 1px solid transparent;
  }

  .model-row:hover,
  .model-row.is-active {
    background: var(--surface-hover);
    border-color: var(--border);
  }

  .runtime-card {
    background: var(--surface);
  }

  .field {
    height: 32px;
    width: 100%;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-hover);
    padding: 0 10px;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }

  .field:focus {
    border-color: var(--border-hover);
  }

  .primary-btn,
  .secondary-btn {
    display: inline-flex;
    height: 32px;
    align-items: center;
    gap: 6px;
    border-radius: 6px;
    padding: 0 12px;
    font-size: 12px;
    transition: opacity 0.15s ease, background 0.15s ease;
  }

  .primary-btn {
    background: var(--text);
    color: var(--surface);
  }

  .secondary-btn {
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .primary-btn:hover,
  .secondary-btn:hover {
    opacity: 0.86;
  }

  .primary-btn:disabled,
  .secondary-btn:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .icon-btn {
    display: inline-flex;
    height: 28px;
    width: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    background: transparent;
  }

  .icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .meta-label {
    margin-bottom: 4px;
    color: var(--text-tertiary);
    font-size: 11px;
    text-transform: uppercase;
  }

  .meta-value {
    overflow: hidden;
    color: var(--text);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-text {
    border-radius: 6px;
    background: var(--surface-hover);
    padding: 4px 8px;
  }

  .toggle-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .endpoint-row {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }

  .endpoint-row code {
    overflow: hidden;
    border-radius: 4px;
    background: var(--surface-hover);
    padding: 4px 6px;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .request-body {
    resize: vertical;
  }

  .console-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .console-code {
    max-height: 180px;
    overflow: auto;
    border-radius: 6px;
    background: var(--surface-hover);
    padding: 10px;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  @media (max-width: 1180px) {
    .developer-panel > div {
      grid-template-columns: 240px minmax(360px, 1fr);
    }

    .developer-panel > div > aside:last-child {
      grid-column: 1 / -1;
      min-height: 360px;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
  }
</style>
