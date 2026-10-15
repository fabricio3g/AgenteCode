<svelte:options runes={true} />

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiRange from '$lib/components/ui/Range.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { motionFade, motionFly } from '$lib/utils/transitions';
  import { Settings, X, Cpu, ExternalLink, MemoryStick, Zap, Sliders } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { providerLabel } from '$lib/utils/providers';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isElectron } from '$lib/services/bridge';

  const currentMode = $derived(appStore.backendMode);
  const runtimeStatus = $derived(modelsStore.status);

  let mode = $state<'api' | 'local'>('api');
  let temperature = $state(0.7);
  let maxTokens = $state(0);
  let systemPrompt = $state('');
  let saving = $state(false);

  $effect(() => {
    if (appStore.llmDrawerOpen && !saving) {
      mode = currentMode as 'api' | 'local';
      // Only a local model is tuned here; an API provider runs as the
      // Rust core configures it (Settings → Providers).
      const cfg = appStore.config;
      temperature = Number(cfg.llm?.local?.temperature ?? 0.7);
      maxTokens = Number(cfg.llm?.local?.max_tokens ?? 0);
      systemPrompt = cfg.llm?.local?.system_prompt || cfg.llm?.system_prompt || '';
    }
  });

  async function save() {
    saving = true;
    try {
      await appStore.setBackendMode(mode);
      if (mode === 'local') {
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

  const activeProviderLabel = $derived(appStore.activeProviderName ? providerLabel(appStore.activeProviderName) : 'API');
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
    class="fixed inset-0"
    style="z-index: var(--z-drawer);"
    role="presentation"
    onclick={() => (appStore.llmDrawerOpen = false)}
    transition:motionFade={{ duration: 150 }}
  ></div>
{/if}

<!-- Drawer -->
{#if appStore.llmDrawerOpen}
<!-- Floats clear of the window edges like the activity panel, rather than
     anchoring flush to the right as a full-height drawer. -->
<aside
  use:modalLayer={{ onclose: () => (appStore.llmDrawerOpen = false), zToken: '--z-drawer' }}
  class="fixed bottom-3 right-3 top-12 flex w-80 flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--float-border)] bg-[var(--float-bg)] shadow-[shadow:var(--float-shadow)]"
  aria-label="Generation settings"
  transition:motionFly={{ x: 24, duration: 260, opacity: 0 }}
>
  <!-- ── Header ─────────────────────────────────────────────────── -->
  <div class="flex items-center justify-between px-4 py-3">
    <div class="flex items-center gap-2">
      <div class="flex size-7 items-center justify-center rounded-full bg-muted">
        <Sliders class="size-4 text-foreground" />
      </div>
      <span class="text-sm font-semibold text-foreground">Generation</span>
    </div>
    <Tooltip label="Close" position="bottom"><UiIconButton label={"Close"} size="sm"
      type="button"

      onclick={() => (appStore.llmDrawerOpen = false)}

    >
      <X class="size-4" />
    </UiIconButton></Tooltip>
  </div>

  <!-- ── Body ───────────────────────────────────────────────────── -->
  <div class="flex-1 overflow-y-auto">

    <!-- Backend pill tabs -->
    <div class="px-4 pt-2">
      <div class="ui-segmented w-full">
        <Button variant="plain"
          type="button"
          class={uiClass(`ui-segmented-item flex-1 py-1.5 ${mode === 'api' ? 'is-active' : ''}`)}
          onclick={() => { mode = 'api'; }}
        >API</Button>
        {#if isElectron()}
          <Button variant="plain"
            type="button"
            class={uiClass(`ui-segmented-item flex-1 py-1.5 ${mode === 'local' ? 'is-active' : ''}`)}
            onclick={() => { mode = 'local'; }}
          >Local</Button>
        {/if}
      </div>
    </div>

    <!-- Status -->
    <div class="mx-4 mt-3 pb-3">
      {#if mode === 'api'}
        <Button variant="plain"
          type="button"
          class={uiClass("flex w-full items-center gap-3 rounded-xl bg-[var(--muted)] px-3 py-3 text-left transition hover:bg-[var(--surface-hover)]")}
          onclick={() => { appStore.llmDrawerOpen = false; appStore.openSettings('providers'); }}
          title="Providers, keys and models are set in Settings and shared with Agente Code in the terminal."
        >
          <span class="flex size-8 shrink-0 items-center justify-center text-foreground">
            <Zap class="size-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[length:var(--text-sm)] font-semibold text-foreground">{activeProviderLabel}</span>
            <span class="block truncate text-xs text-muted-foreground">{activeModelShort}</span>
          </span>
          <ExternalLink class="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      {:else}
        <div class="px-3.5 py-3">
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="flex items-center gap-2">
              <Cpu class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <span class="text-[length:var(--text-xs)] font-semibold text-[var(--text)]">Local Runtime</span>
            </div>
            <span class="runtime-status rounded-full px-2 py-0.5 text-[length:var(--text-xs)] font-semibold {runtimeRunning ? 'running' : 'stopped'}">
              {#if runtimeRunning}<span class="status-dot h-1.5 w-1.5 rounded-full animate-pulse"></span>Running{:else}Stopped{/if}
            </span>
          </div>
          <div class="mb-2.5 truncate text-[length:var(--text-sm)] font-medium text-[var(--text)]">{activeModelShort}</div>

          {#if hardwareStore.info}
            <div class="space-y-2 pt-1">
              <!-- RAM bar -->
              <div>
                <div class="mb-1 flex items-center justify-between text-[length:var(--text-xs)] text-[var(--text-muted)]">
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
                <div class="flex items-center gap-1 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                  <Cpu class="h-3 w-3 shrink-0" />
                  <span class="truncate">{hardwareStore.info.gpu_name || 'GPU'} · {hardwareStore.info.vram_gb.toFixed(1)} GB · {hardwareStore.backendLabel}</span>
                </div>
              {:else}
                <div class="flex items-center gap-1 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                  <Cpu class="h-3 w-3 shrink-0" />
                  <span class="truncate">{hardwareStore.info.cpu_model || 'CPU'} · {hardwareStore.info.physical_cores}c · CPU only</span>
                </div>
              {/if}
            </div>
          {/if}

          <div class="mt-3 flex items-center gap-3">
            <Button variant="plain"
              class={uiClass("text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]")}
              onclick={() => { appStore.llmDrawerOpen = false; appStore.openSettings('models'); }}
            >Manage models</Button>
            <Button variant="plain"
              class={uiClass("inline-flex items-center gap-1 text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]")}
              onclick={() => { appStore.llmDrawerOpen = false; appStore.openSettings('runtime'); }}
              title="Runtime settings"
            ><ExternalLink class="h-3.5 w-3.5" />Runtime</Button>
          </div>
        </div>
      {/if}
    </div>

    <!-- ── Parameters (local model only) ───────────────────────── -->
    {#if mode === 'local'}
    <div class="px-4 pt-4 space-y-4">

      <!-- Temperature -->
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[length:var(--text-xs)] font-semibold r text-[var(--text-muted)]">Temperature</span>
          <div class="flex items-center gap-1.5">
            <span class="text-[length:var(--text-xs)] text-[var(--text-muted)]">{tempLabel(temperature)}</span>
            <span class="min-w-[2.5rem] px-1 text-center text-[length:var(--text-xs)] font-semibold tabular-nums text-[var(--text)]">{temperature.toFixed(2)}</span>
          </div>
        </div>
        <UiRange  bind:value={temperature} min="0" max="2" step="0.05" class={uiClass("w-full accent-[var(--primary)] cursor-pointer")} />
        <div class="mt-1 flex justify-between text-[length:var(--text-xs)] text-[var(--text-muted)]">
          <span>Precise</span><span>Creative</span>
        </div>
      </div>

      <!-- Max tokens -->
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[length:var(--text-xs)] font-semibold r text-[var(--text-muted)]">Max tokens</span>
          <span class="min-w-[2.5rem] px-1 text-center text-[length:var(--text-xs)] font-semibold tabular-nums text-[var(--text)]">{maxTokens > 0 ? maxTokens.toLocaleString() : 'Auto'}</span>
        </div>
        <UiRange  bind:value={maxTokens} min="0" max="32768" step="256" class={uiClass("w-full accent-[var(--primary)] cursor-pointer")} />
      </div>

      <!-- System prompt -->
      <div>
        <label for="llm-system-prompt" class="mb-1.5 block text-[length:var(--text-xs)] font-semibold r text-[var(--text-muted)]">System prompt</label>
        <UiTextarea
          id="llm-system-prompt"
          bind:value={systemPrompt}
          rows={5}
          class={uiClass(" resize-none text-[length:var(--text-xs)] leading-relaxed")}
          placeholder="You are a helpful AI assistant."
        ></UiTextarea>
      </div>

    </div>
    {/if}

    <div class="h-4"></div>
  </div>

  <!-- ── Footer ─────────────────────────────────────────────────── -->
  <div class="shrink-0 px-4 py-3">
    <Button variant="default" size="lg" class="w-full"
      type="button"
      onclick={save}
      disabled={saving}
    >
      {saving ? 'Saving…' : mode === currentMode && mode === 'api' ? 'Done' : 'Apply settings'}
    </Button>
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
  /* Running is the normal state: the dot says it, the pill stays quiet. */
  .runtime-status.running {
    color: var(--muted-foreground);
    background: transparent;
  }
  .status-dot {
    background: var(--status-success);
  }
  :global(.dark) .status-dot {
    background: var(--status-success-dark);
  }
  .ram-bar {
    background: var(--muted-foreground);
    border-radius: var(--radius-full);
  }
  :global(.dark) .ram-bar {
    background: var(--success);
  }
</style>
