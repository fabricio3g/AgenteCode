<svelte:options runes={true} />

<!--
  The provider and model a bot works with. "Same as the chat" leaves the
  bot unpinned: it follows whatever model the app is using. Otherwise the
  bot always uses its own, from any provider set up in Settings, and it can
  be changed later from the bot's settings.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { LoaderCircle } from 'lucide-svelte';
  import { Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { configuredProviders, defaultBaseUrl } from '$lib/utils/providers';

  type Pin = { provider: string; model: string };

  let { value = $bindable() }: { value?: Pin } = $props();

  const initial = untrack(() => value);
  let provider = $state(initial?.provider ?? '');
  let model = $state(initial?.model ?? '');
  let models = $state<string[]>([]);
  let loading = $state(false);
  let open = $state(false);
  let highlighted = $state(0);

  const providers = $derived(configuredProviders(appStore.config, { includeActiveAlways: true }));
  const providerOptions = $derived([
    { value: '', label: $t('bots.modelSame') },
    ...providers.map((option) => ({ value: option.id, label: option.label })),
    // A pinned provider that is no longer set up still shows as chosen.
    ...(provider && !providers.some((option) => option.id === provider) ? [{ value: provider, label: provider }] : [])
  ]);
  const suggestions = $derived.by(() => {
    const query = model.trim().toLowerCase();
    return models.filter((id) => !query || id.toLowerCase().includes(query)).slice(0, 8);
  });

  // The pin the rest of the editor saves: unset while "Same as the chat".
  $effect(() => {
    value = provider && model.trim() ? { provider, model: model.trim() } : undefined;
  });

  $effect(() => {
    if (provider) void load(provider);
  });

  async function load(id: string) {
    const saved = appStore.config.llm?.providers?.[id];
    models = saved?.model ? [String(saved.model)] : [];
    if (!isElectron()) return;
    loading = true;
    try {
      const baseUrl = saved?.base_url || defaultBaseUrl(id);
      // An empty key: the main process uses the one stored for the provider.
      const ids = await invoke<string[]>('fetch_provider_models', { baseUrl, apiKey: '', providerName: id });
      if (provider === id && Array.isArray(ids) && ids.length) models = [...new Set(ids.map(String))].sort();
    } catch {
      // Keep the saved model; the field still accepts any model id.
    } finally {
      if (provider === id) loading = false;
    }
  }

  function chooseProvider(id: string) {
    provider = id;
    model = id ? String(appStore.config.llm?.providers?.[id]?.model ?? '') : '';
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
</style>
