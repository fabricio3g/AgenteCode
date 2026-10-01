<svelte:options runes={true} />

<!--
  The provider, model and thinking level a bot works with. "Same as the chat"
  leaves the bot unpinned: it follows the model its asker uses (the app's, a
  routine's, a teammate's), or the server's default. Otherwise the bot always
  uses its own, from any provider set up in Settings. Model lists come from
  the same shared loader as the composer's model menu, and the thinking level
  from the same selector, fed this model's capabilities.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { LoaderCircle } from 'lucide-svelte';
  import { Select } from '$lib/components/ui';
  import ReasoningLevelSelector from '$lib/features/chat/composer/ReasoningLevelSelector.svelte';
  import { fetchReasoningCapabilities } from '$lib/services/chat-api';
  import { appStore } from '$lib/stores/app.svelte';
  import { providerModels } from '$lib/stores/provider-models.svelte';
  import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';
  import { configuredProviders } from '$lib/utils/providers';

  type Pin = { provider: string; model: string; thinking?: string };

  let { value = $bindable() }: { value?: Pin } = $props();

  const initial = untrack(() => value);
  let provider = $state(initial?.provider ?? '');
  let model = $state(initial?.model ?? '');
  let thinking = $state<ReasoningLevel | null>((initial?.thinking as ReasoningLevel | undefined) ?? null);
  let capabilities = $state<ReasoningCapabilities>({ supported: false, levels: [], source: 'unknown' });
  let open = $state(false);
  let highlighted = $state(0);

  const providers = $derived(configuredProviders(appStore.config, { includeActiveAlways: true }));
  const providerOptions = $derived([
    { value: '', label: $t('bots.modelSame') },
    ...providers.map((option) => ({ value: option.id, label: option.label })),
    // A pinned provider that is no longer set up still shows as chosen.
    ...(provider && !providers.some((option) => option.id === provider) ? [{ value: provider, label: provider }] : [])
  ]);
  const loading = $derived(!!(provider && providerModels.loading[provider]));
  const suggestions = $derived.by(() => {
    if (!provider) return [];
    const query = model.trim().toLowerCase();
    return providerModels.models(provider).map((option) => option.id)
      .filter((id) => !query || id.toLowerCase().includes(query)).slice(0, 8);
  });

  // The pin the rest of the editor saves: unset while "Same as the chat".
  $effect(() => {
    value = provider && model.trim()
      ? { provider, model: model.trim(), ...(thinking ? { thinking } : {}) }
      : undefined;
  });

  $effect(() => {
    if (provider) void providerModels.load(provider);
  });

  // What this model can think at; a level it doesn't offer falls back to auto.
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

  function chooseProvider(id: string) {
    provider = id;
    model = id ? String(appStore.config.llm?.providers?.[id]?.model ?? '') : '';
    thinking = null;
  }

  function pick(id: string) {
    model = id;
    open = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open || !suggestions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlighted = (highlighted + step + suggestions.length) % suggestions.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(suggestions[highlighted]);
    } else if (event.key === 'Escape') {
      open = false;
    }
  }
</script>

<div class="space-y-2">
  <Select aria-label={$t('bots.provider')} value={provider} options={providerOptions} onchange={chooseProvider} />
  {#if provider}
    <div class="relative">
      <input
        class="ui-input pr-8"
        bind:value={model}
        placeholder={$t('bots.modelPlaceholder')}
        aria-label={$t('bots.model')}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls="bot-model-list"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        onfocus={() => { open = true; highlighted = 0; }}
        oninput={() => { open = true; highlighted = 0; }}
        onblur={() => (open = false)}
        onkeydown={onKeydown}
      />
      {#if loading}<LoaderCircle class="absolute right-2.5 top-2 size-4 animate-spin text-muted-foreground" />{/if}
      {#if open && suggestions.length}
        <ul id="bot-model-list" class="models" role="listbox" aria-label={$t('bots.model')}>
          {#each suggestions as id, index (id)}
            <li role="option" aria-selected={index === highlighted}>
              <button type="button" class="model" class:on={index === highlighted} onmousedown={(event) => event.preventDefault()} onclick={() => pick(id)}>{id}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if capabilities.supported && capabilities.levels.length}
      <div class="thinking-row">
        <span class="text-[12px] text-muted-foreground">{$t('bots.thinking')}</span>
        <ReasoningLevelSelector {capabilities} value={thinking} onchange={(level) => (thinking = level)} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .models {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    z-index: 20;
    max-height: 14rem;
    overflow-y: auto;
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background: var(--popover);
    padding: 0.25rem;
    box-shadow: var(--shadow-lg);
  }
  .model {
    display: block;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: 0.5rem;
    padding: 0.35rem 0.5rem;
    text-align: left;
    font-size: 13px;
  }
  .model.on { background: var(--surface-hover); }
  .thinking-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
</style>
