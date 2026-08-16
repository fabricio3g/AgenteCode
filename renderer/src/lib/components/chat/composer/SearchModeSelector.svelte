<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Globe2, Layers, Radar, WifiOff } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { Menu } from '$lib/components/ui';

  type SearchModeId = keyof typeof copy.searchModes;

  const MODE_IDS: SearchModeId[] = ['chat', 'search', 'deep', 'max'];
  const MODE_ICONS = { chat: WifiOff, search: Globe2, deep: Layers, max: Radar } as const;

  let open = $state(false);

  const current = $derived(MODE_IDS.find((id) => id === appStore.searchMode) || 'chat');
  const CurrentIcon = $derived(MODE_ICONS[current]);

  function select(mode: SearchModeId) {
    appStore.setSearchMode(mode);
    open = false;
  }
</script>

<Menu bind:open placement="top-start" minWidth="13.5rem" label={copy.composer.selectSearchMode}>
  {#snippet trigger(props)}
    <button
      type="button"
      class="aui-select-trigger aui-pill mode-trigger"
      class:is-emphasized={current === 'deep' || current === 'max'}
      title={copy.searchModes[current].description}
      {...props}
    >
      <CurrentIcon class="size-3.5 {current === 'chat' ? 'opacity-70' : 'opacity-80'}" />
      <span>{copy.searchModes[current].label}</span>
      <ChevronDown class="size-3 transition-transform duration-150 {open ? 'rotate-180' : ''}" />
    </button>
  {/snippet}

  {#each MODE_IDS as id (id)}
    <button
      type="button"
      role="menuitem"
      class="mode-item"
      class:is-active={appStore.searchMode === id}
      onclick={() => select(id)}
    >
      <span class="mode-item-title">{copy.searchModes[id].label}</span>
      <span class="mode-item-desc">{copy.searchModes[id].description}</span>
    </button>
  {/each}
</Menu>

<style>
  .mode-trigger {
    gap: 0.35rem;
  }

  .mode-trigger.is-emphasized {
    color: var(--foreground);
    font-weight: 600;
  }

  .mode-item {
    display: flex;
    width: 100%;
    padding: 0.45rem 0.55rem;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: background 120ms ease;
  }

  .mode-item:hover,
  .mode-item:focus-visible {
    background: var(--muted);
    outline: none;
  }

  .mode-item.is-active {
    background: color-mix(in srgb, var(--muted) 85%, var(--foreground) 6%);
  }

  .mode-item-title {
    color: var(--foreground);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .mode-item-desc {
    color: var(--text-secondary);
    /* 0.68rem landed at ~11px, below the point where this stays comfortable. */
    font-size: 0.75rem;
    font-weight: 450;
    line-height: 1.4;
  }
</style>
