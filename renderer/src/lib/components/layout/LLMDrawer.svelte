<svelte:options runes={true} />

<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { Settings, X, Cpu, ExternalLink, MemoryStick, Zap, Sliders } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isTauri } from '$lib/services/tauri';

  const currentMode = $derived(appStore.backendMode);
  const runtimeStatus = $derived(modelsStore.status);

  let mode = $state<'api' | 'local'>('api');
  let temperature = $state(0.7);
  let topP = $state(0.95);
  let maxTokens = $state(0);
  let systemPrompt = $state('');
  let saving = $state(false);

  $effect(() => {
    if (appStore.llmDrawerOpen && !saving) {
      mode = currentMode as 'api' | 'local';
      const cfg = appStore.config;
      if (mode === 'api') {
        const provider = appStore.activeProvider;
        temperature = Number(provider?.temperature ?? 0.7);
        topP = Number(provider?.top_p ?? 0.95);
        maxTokens = Number(provider?.max_tokens ?? 0);
        systemPrompt = provider?.system_prompt || cfg.llm?.system_prompt || '';
      } else {
        temperature = Number(cfg.llm?.local?.temperature ?? 0.7);
        maxTokens = Number(cfg.llm?.local?.max_tokens ?? 0);
        topP = 0.95;
        systemPrompt = cfg.llm?.local?.system_prompt || cfg.llm?.system_prompt || '';
      }
    }
  });

  async function save() {
    saving = true;
    try {
      await appStore.setBackendMode(mode);
      if (mode === 'api') {
        await appStore.updateProvider({
          provider: appStore.activeProviderName,
          temperature,
          top_p: topP,
          max_tokens: maxTokens > 0 ? maxTokens : undefined,
          system_prompt: systemPrompt || undefined,
        });
      } else {
        await appStore.updateLocalSettings({
          temperature,
          max_tokens: maxTokens > 0 ? maxTokens : undefined,
          system_prompt: systemPrompt || undefined,
        });
      }
      toastStore.success('Settings saved');
      appStore.llmDrawerOpen = false;
    } catch (e: any) {
      toastStore.error(`Failed to save: ${e.message}`);
    } finally {
      saving = false;
    }
  }

  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic',
    groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek',
    lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom'
  };
  const providerLabel = $derived(PROVIDER_LABELS[appStore.activeProviderName] || appStore.activeProviderName || 'API');
  const activeModel = $derived(
    mode === 'local'
      ? (runtimeStatus?.active_model || appStore.config.llm?.local?.model || null)
      : appStore.activeProvider?.model || null
  );
  const activeModelShort = $derived(activeModel ? (activeModel.split('/').pop() || activeModel).replace(/\.gguf$/i, '') : 'No model');
  const runtimeRunning = $derived.by(() => {
    const state = String(runtimeStatus?.state || '');
    return state === 'ready' || state === 'model_ready';
  });

  function tempLabel(v: number) {
    if (v <= 0.3) return 'Precise';
    if (v <= 0.7) return 'Balanced';
    if (v <= 1.2) return 'Creative';
    return 'Wild';
  }
</script>

<!-- Backdrop -->
{#if appStore.llmDrawerOpen}
  <div
    class="modal-backdrop fixed inset-0 z-[55] bg-overlay-light"
    role="presentation"
    onclick={() => (appStore.llmDrawerOpen = false)}
    transition:fade={{ duration: 150 }}
  ></div>
{/if}

<!-- Drawer -->
{#if appStore.llmDrawerOpen}
<aside
  class="modal-surface fixed right-0 top-0 z-[56] flex h-full w-80 flex-col overflow-hidden border-l border-[var(--border)] shadow-2xl"
  style="background: var(--surface)"
  aria-label="Generation settings"
  transition:fly={{ x: 320, duration: 220, opacity: 1 }}
>
  <!-- ── Header ─────────────────────────────────────────────────── -->
  <div class="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border)]">
    <div class="flex items-center gap-2">
      <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary)]/10">
        <Sliders class="h-4 w-4 text-[var(--primary)]" />
      </div>
      <span class="text-[14px] font-semibold text-[var(--text)]">Generation</span>
    </div>
    <button
      class="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      onclick={() => (appStore.llmDrawerOpen = false)}
      aria-label="Close"
    >
      <X class="h-4 w-4" />
    </button>
  </div>

  <!-- ── Body ───────────────────────────────────────────────────── -->
  <div class="flex-1 overflow-y-auto">

    <!-- Backend pill tabs -->
    <div class="px-4 pt-4">
      <div class="flex gap-1 border-b border-[var(--border)] pb-2">
        <button
          class="rounded-md px-3 py-1.5 text-[13px] font-medium transition {mode === 'api' ? 'text-[var(--text)] bg-[var(--surface-hover)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}"
          onclick={() => { mode = 'api'; }}
        >API</button>
        {#if isTauri()}
          <button
            class="rounded-md px-3 py-1.5 text-[13px] font-medium transition {mode === 'local' ? 'text-[var(--text)] bg-[var(--surface-hover)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}"
            onclick={() => { mode = 'local'; }}
          >Local</button>
        {/if}
      </div>
    </div>

    <!-- Status -->
    <div class="mx-4 mt-3 border-b border-[var(--border)] pb-3">
      {#if mode === 'api'}
        <div class="flex items-center gap-3 px-3.5 py-3">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
            <Zap class="h-4 w-4" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13px] font-semibold text-[var(--text)]">{providerLabel}</div>
            <div class="truncate text-[11px] text-[var(--text-muted)]">{activeModelShort}</div>
          </div>
          <button
            class="shrink-0 rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--border)] hover:text-[var(--text)]"
            onclick={() => { appStore.llmDrawerOpen = false; appStore.modelManagerOpenSection = 'providers'; appStore.modelManagerOpen = true; }}
            title="Configure"
          ><ExternalLink class="h-3.5 w-3.5" /></button>
        </div>
      {:else}
        <div class="px-3.5 py-3">
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="flex items-center gap-2">
              <Cpu class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <span class="text-[12px] font-semibold text-[var(--text)]">Local Runtime</span>
            </div>
            <span class="runtime-status rounded-full px-2 py-0.5 text-[10px] font-semibold {runtimeRunning ? 'running' : 'stopped'}">
              {#if runtimeRunning}<span class="status-dot h-1.5 w-1.5 rounded-full animate-pulse"></span>Running{:else}Stopped{/if}
            </span>
          </div>
          <div class="mb-2.5 truncate text-[13px] font-medium text-[var(--text)]">{activeModelShort}</div>

          {#if hardwareStore.info}
            <div class="space-y-2 pt-1">
              <!-- RAM bar -->
              <div>
                <div class="mb-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                  <span class="flex items-center gap-1"><MemoryStick class="h-3 w-3" /> RAM</span>
                  <span class="tabular-nums">{hardwareStore.ramUsedGb.toFixed(1)} / {hardwareStore.info.total_ram_gb.toFixed(0)} GB</span>
                </div>
                  <div class="h-1 w-full overflow-hidden rounded-full" style="background:var(--border)">
                    <div
                      class="ram-bar h-full rounded-full transition-all"
                      style="width:{Math.min(100, hardwareStore.ramUsedPercent)}%"
                    ></div>
                  </div>
              </div>
              {#if hardwareStore.info.vram_gb > 0}
                <div class="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <Cpu class="h-3 w-3 shrink-0" />
                  <span class="truncate">{hardwareStore.info.gpu_name || 'GPU'} · {hardwareStore.info.vram_gb.toFixed(1)} GB · {hardwareStore.backendLabel}</span>
                </div>
              {:else}
                <div class="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <Cpu class="h-3 w-3 shrink-0" />
                  <span class="truncate">{hardwareStore.info.cpu_model || 'CPU'} · {hardwareStore.info.physical_cores}c · CPU only</span>
                </div>
              {/if}
            </div>
          {/if}

          <div class="mt-3 flex items-center gap-3">
            <button
              class="text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]"
              onclick={() => { appStore.llmDrawerOpen = false; appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
            >Manage models</button>
            <button
              class="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]"
              onclick={() => { appStore.llmDrawerOpen = false; appStore.modelManagerOpenSection = 'runtime'; appStore.modelManagerOpen = true; }}
              title="Runtime settings"
            ><ExternalLink class="h-3.5 w-3.5" />Runtime</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- ── Parameters ─────────────────────────────────────────── -->
    <div class="px-4 pt-4 space-y-4">

      <!-- Temperature -->
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Temperature</span>
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] text-[var(--text-muted)]">{tempLabel(temperature)}</span>
            <span class="min-w-[2.5rem] px-1 text-center text-[12px] font-semibold tabular-nums text-[var(--text)]">{temperature.toFixed(2)}</span>
          </div>
        </div>
        <input type="range" bind:value={temperature} min="0" max="2" step="0.05" class="w-full accent-[var(--primary)] cursor-pointer" />
        <div class="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
          <span>Precise</span><span>Creative</span>
        </div>
      </div>

      {#if mode === 'api'}
        <!-- Top-P -->
        <div>
          <div class="mb-2 flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Top P</span>
            <span class="min-w-[2.5rem] px-1 text-center text-[12px] font-semibold tabular-nums text-[var(--text)]">{topP.toFixed(2)}</span>
          </div>
          <input type="range" bind:value={topP} min="0" max="1" step="0.01" class="w-full accent-[var(--primary)] cursor-pointer" />
        </div>
      {/if}

      <!-- Max tokens -->
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Max tokens</span>
          <span class="min-w-[2.5rem] px-1 text-center text-[12px] font-semibold tabular-nums text-[var(--text)]">{maxTokens > 0 ? maxTokens.toLocaleString() : 'Auto'}</span>
        </div>
        <input type="range" bind:value={maxTokens} min="0" max="32768" step="256" class="w-full accent-[var(--primary)] cursor-pointer" />
      </div>

      <!-- System prompt -->
      <div>
        <label for="llm-system-prompt" class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">System prompt</label>
        <textarea
          id="llm-system-prompt"
          bind:value={systemPrompt}
          rows="5"
          class="w-full rounded-lg bg-[var(--surface)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] resize-none"
          placeholder="You are a helpful AI assistant."
        ></textarea>
      </div>

    </div>

    <div class="h-4"></div>
  </div>

  <!-- ── Footer ─────────────────────────────────────────────────── -->
  <div class="shrink-0 border-t border-[var(--border)] px-4 py-3">
    <button
      class="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold text-primary-fg transition hover:opacity-90 disabled:opacity-50"
      style="background:var(--primary)"
      onclick={save}
      disabled={saving}
    >
      {saving ? 'Saving…' : 'Apply settings'}
    </button>
  </div>
</aside>
{/if}

<style>
  .runtime-status {
    color: var(--text-tertiary);
    background: var(--surface-hover);
    border: none;
    border-radius: var(--radius-sm);
  }
  .runtime-status.running {
    color: var(--status-success);
    background: var(--success-bg);
  }
  :global(.dark) .runtime-status.running {
    color: var(--status-success-dark);
  }
  .status-dot {
    background: var(--status-success);
  }
  :global(.dark) .status-dot {
    background: var(--status-success-dark);
  }
  .ram-bar {
    background: var(--success);
    border-radius: var(--radius-full);
  }
  :global(.dark) .ram-bar {
    background: var(--success);
  }
</style>
