<svelte:options runes={true} />

<!--
  What a bot, a subagent type or the compactor runs on: a trigger that names the
  model, the shared model list behind it, and the thinking level under it.

  It used to be a bare combobox whose suggestions only appeared while typing —
  eight of them, no search, nothing to browse. Choosing a model is the same
  question everywhere in the app, so it opens the same dialog the composer does.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ChevronDown } from '$lib/icons';
  import ReasoningLevelSelector from '$lib/features/chat/composer/ReasoningLevelSelector.svelte';
  import ModelPickerDialog from '$lib/features/shared/ModelPickerDialog.svelte';
  import { fetchReasoningCapabilities } from '$lib/services/chat-api';
  import { appStore } from '$lib/stores/app.svelte';
  import { providerModels } from '$lib/stores/provider-models.svelte';
  import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';
  import { configuredProviders } from '$lib/utils/providers';

  type Pin = { provider: string; model: string; thinking?: string };

  let {
    value = $bindable(),
    compact = false,
    placeholder,
    onchange
  }: {
    value?: Pin;
    /** One thin line: model button and thinking level side by side. */
    compact?: boolean;
    /** What the trigger says with nothing chosen; by default, that the chat's model applies. */
    placeholder?: string;
    onchange?: (pin: Pin | undefined) => void;
  } = $props();

  const initial = untrack(() => value);
  let provider = $state(initial?.provider ?? '');
  let model = $state(initial?.model ?? '');
  let thinking = $state<ReasoningLevel | null>((initial?.thinking as ReasoningLevel | undefined) ?? null);
  let capabilities = $state<ReasoningCapabilities>({ supported: false, levels: [], source: 'unknown' });
  let open = $state(false);

  const providers = $derived(configuredProviders(appStore.config, { includeActiveAlways: true }));
  const providerLabel = $derived(providers.find((option) => option.id === provider)?.label ?? provider);
  const label = $derived(model ? `${providerLabel} · ${model}` : (placeholder ?? $t('bots.modelSame')));

  // The pin the rest of the editor saves: unset while nothing is chosen.
  // The first pass only reads the initial value back, so it is not a change.
  let reported = false;
  $effect(() => {
    const next = provider && model.trim()
      ? { provider, model: model.trim(), ...(thinking ? { thinking } : {}) }
      : undefined;
    value = next;
    if (!reported) {
      reported = true;
      return;
    }
    onchange?.(next);
  });

  $effect(() => {
    if (provider) void providerModels.load(provider);
  });

  // What this model can think at; a level it does not offer falls back to auto.
  $effect(() => {
    const id = provider, name = model.trim();
    if (!id || !name) {
      capabilities = { supported: false, levels: [], source: 'unknown' };
      return;
    }
    const timer = setTimeout(async () => {
      const saved = appStore.config.llm?.providers?.[id];
      const next = await fetchReasoningCapabilities({ providerName: id, model: name, baseUrl: saved?.base_url });
      if (id !== provider || name !== model.trim()) return;
      capabilities = next;
      if (thinking && next.supported && !next.levels.includes(thinking)) thinking = null;
    }, 300);
    return () => clearTimeout(timer);
  });

  function pick(nextProvider: string, nextModel: string) {
    provider = nextProvider;
    model = nextModel;
    // A different model offers different levels; auto until it says otherwise.
    thinking = null;
  }
</script>

<div class={compact ? 'picker is-compact' : 'space-y-2'}>
  <UiButton variant="plain" type="button" class={uiClass("model-trigger", "ui-local-80672c10")} onclick={() => (open = true)} aria-haspopup="dialog" aria-expanded={open}>
    <span class="min-w-0 flex-1 truncate">{label}</span>
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
  </UiButton>

  <ModelPickerDialog
    bind:open
    title={$t('bots.model')}
    selected={provider && model ? { provider, model } : null}
    onpick={pick}
  />

  {#if capabilities.supported && capabilities.levels.length}
    <div class="thinking-row">
      {#if !compact}<span class="text-[length:var(--text-xs)] text-muted-foreground">{$t('bots.thinking')}</span>{/if}
      <ReasoningLevelSelector {capabilities} value={thinking} onchange={(level) => (thinking = level)} />
    </div>
  {/if}
</div>

<style>
  /* The same field shape as the inputs beside it: a row that says what it holds
     and opens the list. */
  :global(.model-trigger.ui-local-80672c10) {
    display: flex;
    width: 100%;
    height: 2.75rem;
    align-items: center;
    gap: 0.625rem;
    padding: 0 0.875rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--background);
    color: var(--foreground);
    font-size: var(--text-base);
    text-align: left;
    transition: border-color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  :global(.model-trigger:hover.ui-local-80672c10),
  :global(.model-trigger:focus-visible.ui-local-80672c10) {
    background: var(--surface-hover);
  }
  .thinking-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .picker.is-compact { display: flex; min-width: 0; max-width: 100%; align-items: center; justify-content: flex-end; gap: 0.25rem; }
  .is-compact :global(.model-trigger.ui-local-80672c10) { width: auto; min-width: 0; max-width: 100%; height: 1.75rem; gap: 0.375rem; padding: 0 0.625rem; border-radius: var(--radius-full); background: transparent; font-size: var(--text-sm); }
  .is-compact .thinking-row { flex-shrink: 0; }
</style>
