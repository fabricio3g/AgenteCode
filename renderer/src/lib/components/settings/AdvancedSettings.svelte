<svelte:options runes={true} />

<script lang="ts">
  import { LoaderCircle, Wifi, Cpu } from 'lucide-svelte';
  import { isTauri } from '$lib/services/tauri';
  import { modelsStore } from '$lib/stores/models.svelte';

  let {
    backendMode = $bindable(),
    provider = $bindable(),
    baseUrl = $bindable(),
    apiKey = $bindable(),
    model = $bindable(),
    temperature = $bindable(),
    maxTokens = $bindable(),
    topP = $bindable(),
    systemPrompt = $bindable(),
    localBaseUrl = $bindable(),
    contextLength = $bindable(),
    gpuLayers = $bindable(),
    selectedLocalPath = $bindable(),
    apiModels,
    fetchingModels,
    testingConnection,
    connectionStatus,
    hasApiKey,
    onfetchModels,
    ontestConnection,
    onopenModelManager,
  }: {
    backendMode: 'api' | 'local';
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: string;
    topP: number;
    systemPrompt: string;
    localBaseUrl: string;
    contextLength: string;
    gpuLayers: string;
    selectedLocalPath: string;
    apiModels: string[];
    fetchingModels: boolean;
    testingConnection: boolean;
    connectionStatus: 'idle' | 'ok' | 'fail';
    hasApiKey: boolean;
    onfetchModels: () => void;
    ontestConnection: () => void;
    onopenModelManager: () => void;
  } = $props();
</script>

<div class="space-y-5">
  <!-- Backend mode pill toggle -->
  <div class="space-y-1.5">
    <span class="text-sm font-medium text-[var(--text-secondary)]">Backend mode</span>
    <div class="flex w-full rounded-lg bg-[var(--surface-highlight)] p-1 border border-[var(--border-light)]">
      <button
        class={`flex-1 rounded-md py-2 text-sm font-medium transition ${backendMode === 'api' ? 'bg-[var(--surface)] shadow-sm text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
        onclick={() => (backendMode = 'api')}
      >
        API Provider
      </button>
      <button
        class={`flex-1 rounded-md py-2 text-sm font-medium transition ${backendMode === 'local' ? 'bg-[var(--surface)] shadow-sm text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'} ${!isTauri() ? 'cursor-not-allowed opacity-40' : ''}`}
        onclick={() => isTauri() && (backendMode = 'local')}
        title={!isTauri() ? 'Requires desktop app' : ''}
      >
        Local Runtime
      </button>
    </div>
  </div>

  {#if backendMode === 'api'}
    <!-- Provider -->
    <label class="block space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Provider</span>
      <select class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={provider}>
        <optgroup label="Cloud">
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter (multi-provider)</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="groq">Groq</option>
          <option value="mistral">Mistral AI</option>
          <option value="together">Together AI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="cohere">Cohere</option>
          <option value="perplexity">Perplexity</option>
        </optgroup>
        <optgroup label="Local / Self-hosted">
          <option value="lmstudio">LM Studio</option>
          <option value="ollama">Ollama</option>
          <option value="custom">Custom / Other</option>
        </optgroup>
      </select>
    </label>

    <!-- Base URL -->
    <label class="block space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Base URL</span>
      <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={baseUrl} placeholder="https://api.openai.com/v1" />
    </label>

    <!-- API Key -->
    <div class="space-y-1.5 text-sm">
      <div class="flex items-center justify-between">
        <span class="font-medium text-[var(--text-secondary)]">API key</span>
        {#if hasApiKey}
          <span class="inline-flex items-center gap-1 text-[11px] font-medium text-success">
            <span class="h-1.5 w-1.5 rounded-full bg-success"></span> Saved
          </span>
        {/if}
      </div>
      <input
        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={apiKey}
        placeholder={hasApiKey ? '••••••••• (leave blank to keep)' : 'Enter API key…'}
        type="password"
      />
    </div>

    <!-- Model with fetch button -->
    <div class="space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Model</span>
      <div class="flex gap-2">
        {#if apiModels.length}
          <select class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={model}>
            <option value="">Select a model</option>
            {#each apiModels as m (m)}<option value={m}>{m}</option>{/each}
            {#if model && !apiModels.includes(model)}
              <option value={model}>{model} (custom)</option>
            {/if}
          </select>
        {:else}
          <input class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={model} placeholder="No model" />
        {/if}
        <button
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
          onclick={onfetchModels}
          disabled={fetchingModels}
          title="Fetch available models from provider"
        >
          {#if fetchingModels}
            <LoaderCircle class="h-4 w-4 animate-spin" />
          {:else}
            ↻
          {/if}
          Fetch
        </button>
      </div>
    </div>

    <!-- System Prompt -->
    <label class="block space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">System prompt</span>
      <textarea
        class="h-24 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={systemPrompt}
        placeholder="You are a helpful assistant…"
      ></textarea>
    </label>

    <!-- Generation params row -->
    <div class="space-y-4 text-sm">
      <!-- Temperature slider -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-medium text-[var(--text-secondary)]">Temperature</span>
          <span class="tabular-nums text-xs font-semibold text-hornero-600 dark:text-hornero-400 w-8 text-right">{temperature.toFixed(2)}</span>
        </div>
        <input type="range" min="0" max="2" step="0.05" bind:value={temperature}
          class="w-full h-1.5 rounded-full cursor-pointer accent-[var(--primary)]" />
        <div class="flex justify-between text-[10px] text-[var(--text-muted)]">
          <span>Creative</span><span>Precise</span>
        </div>
      </div>
      <!-- Top-P slider -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-medium text-[var(--text-secondary)]">Top-P</span>
          <span class="tabular-nums text-xs font-semibold text-hornero-600 dark:text-hornero-400 w-8 text-right">{topP.toFixed(2)}</span>
        </div>
        <input type="range" min="0" max="1" step="0.05" bind:value={topP}
          class="w-full h-1.5 rounded-full cursor-pointer accent-[var(--primary)]" />
      </div>
      <!-- Max tokens -->
      <label class="block space-y-1.5">
        <span class="font-medium text-[var(--text-secondary)]">Max tokens</span>
        <input
          class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
          bind:value={maxTokens}
          inputmode="numeric"
          placeholder="2048 (leave blank for provider default)"
        />
      </label>
    </div>
  {:else}
    <!-- Local model selector + manager button -->
    <div class="space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Local model</span>
      <div class="flex gap-2">
        <select class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={selectedLocalPath}>
          <option value="">Select a local GGUF model</option>
          {#each modelsStore.availableModels as localModel (localModel.path || localModel.id)}
            <option value={localModel.path}>{localModel.name}</option>
          {/each}
        </select>
        <button
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]"
          onclick={onopenModelManager}
          title="Open model manager"
        >
          <Cpu class="h-4 w-4" />
          Manager
        </button>
      </div>
    </div>

    <!-- Runtime URL -->
    <label class="block space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Runtime URL</span>
      <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={localBaseUrl} placeholder="http://127.0.0.1:8080/v1" />
    </label>

    <!-- Context + GPU layers side by side -->
    <div class="grid grid-cols-2 gap-4">
      <label class="space-y-1.5 text-sm">
        <span class="font-medium text-[var(--text-secondary)]">Context length</span>
        <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={contextLength} inputmode="numeric" placeholder="default" />
      </label>
      <label class="space-y-1.5 text-sm">
        <span class="font-medium text-[var(--text-secondary)]">GPU layers</span>
        <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={gpuLayers} inputmode="numeric" placeholder="auto" />
      </label>
    </div>

    <!-- Runtime status card -->
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-[var(--text-secondary)]">Runtime status</span>
        {#if modelsStore.status}
          {@const state = typeof modelsStore.status.state === 'string' ? modelsStore.status.state : 'unknown'}
          <span class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${state === 'ready' || state === 'Ready' ? 'bg-success-bg text-success' : state === 'idle' || state === 'Idle' ? 'bg-surface-hl text-fg-secondary' : 'bg-warning-bg text-warning'}`}>
            <span class={`h-1.5 w-1.5 rounded-full ${state === 'ready' || state === 'Ready' ? 'bg-success' : state === 'idle' || state === 'Idle' ? 'bg-fg-muted' : 'bg-warning animate-pulse'}`}></span>
            {modelsStore.statusLabel}
            {#if modelsStore.status.active_model}· {modelsStore.status.active_model}{/if}
          </span>
        {:else}
          <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-hl px-2.5 py-1 text-[11px] font-medium text-fg-muted">
            <span class="h-1.5 w-1.5 rounded-full bg-fg-muted"></span>
            Unavailable
          </span>
        {/if}
      </div>
    </div>

    <!-- System prompt for local mode -->
    <label class="block space-y-1.5 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">System prompt</span>
      <textarea
        class="h-24 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={systemPrompt}
        placeholder="You are a helpful assistant…"
      ></textarea>
    </label>

    <!-- Local generation params -->
    <div class="space-y-4 text-sm">
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-medium text-[var(--text-secondary)]">Temperature</span>
          <span class="tabular-nums text-xs font-semibold text-hornero-600 dark:text-hornero-400 w-8 text-right">{temperature.toFixed(2)}</span>
        </div>
        <input type="range" min="0" max="2" step="0.05" bind:value={temperature}
          class="w-full h-1.5 rounded-full cursor-pointer accent-[var(--primary)]" />
        <div class="flex justify-between text-[10px] text-[var(--text-muted)]">
          <span>Creative</span><span>Precise</span>
        </div>
      </div>
      <label class="block space-y-1.5">
        <span class="font-medium text-[var(--text-secondary)]">Max tokens</span>
        <input
          class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
          bind:value={maxTokens}
          inputmode="numeric"
          placeholder="2048 (leave blank for default)"
        />
      </label>
    </div>
  {/if}

  <div class="flex items-center gap-3 pt-1">
    <button
      class="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
      onclick={ontestConnection}
      disabled={testingConnection}
    >
      {#if testingConnection}
        <LoaderCircle class="h-4 w-4 animate-spin" />
        Testing…
      {:else}
        <Wifi class="h-4 w-4" />
        Test connection
      {/if}
    </button>
    {#if connectionStatus !== 'idle'}
      <span class={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${connectionStatus === 'ok' ? 'bg-success-bg text-success' : 'bg-error-bg text-error'}`}>
        {connectionStatus === 'ok' ? '● Connected' : '● Failed'}
      </span>
    {/if}
  </div>
</div>
