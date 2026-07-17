<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Globe2, Layers, Radar, WifiOff } from 'lucide-svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const searchMode = $derived(appStore.searchMode);

  type SearchModeId = 'chat' | 'search' | 'deep' | 'max';

  const searchModeIds: SearchModeId[] = ['chat', 'search', 'deep', 'max'];

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);

  const currentModeId = $derived(searchModeIds.find((id) => id === searchMode) || searchModeIds[0]);

  function getSearchLabel(id: SearchModeId): string {
    const labels: Record<SearchModeId, string> = {
      chat: $t('composer.searchOff'),
      search: $t('composer.webSearch'),
      deep: $t('composer.deepSearch'),
      max: $t('composer.maxSearch')
    };
    return labels[id] || id;
  }

  function getSearchDesc(id: SearchModeId): string {
    const descs: Record<SearchModeId, string> = {
      chat: $t('composer.searchOffDesc'),
      search: $t('composer.webSearchDesc'),
      deep: $t('composer.deepSearchDesc'),
      max: $t('composer.maxSearchDesc')
    };
    return descs[id] || '';
  }

  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
  }

  function selectMode(mode: SearchModeId) {
    appStore.setSearchMode(mode);
    dropdownOpen = false;
  }

  $effect(() => {
    if (!dropdownOpen || !triggerEl || !dropdownEl) return;
    const trigger = triggerEl;
    const dropdown = dropdownEl;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!trigger.contains(target) && !dropdown.contains(target)) {
        dropdownOpen = false;
      }
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') dropdownOpen = false;
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<div class="relative inline-flex">
  <button
    bind:this={triggerEl}
    type="button"
    class="aui-select-trigger mode-trigger"
    class:is-active={currentModeId !== 'chat'}
    class:is-deep={currentModeId === 'deep'}
    class:is-max={currentModeId === 'max'}
    onclick={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
    title={getSearchDesc(currentModeId)}
  >
    {#if currentModeId === 'chat'}
      <WifiOff class="size-3.5 opacity-70" />
      <span>{getSearchLabel('chat')}</span>
    {:else if currentModeId === 'search'}
      <Globe2 class="size-3.5 opacity-80" />
      <span>{getSearchLabel('search')}</span>
    {:else if currentModeId === 'deep'}
      <Layers class="size-3.5 opacity-80" />
      <span>{getSearchLabel('deep')}</span>
    {:else}
      <Radar class="size-3.5 opacity-80" />
      <span>{getSearchLabel('max')}</span>
    {/if}
    <ChevronDown class={`size-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="aui-menu mode-menu absolute bottom-full z-[200] mb-1 min-w-[13.5rem] origin-bottom"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each searchModeIds as modeId (modeId)}
        <button
          type="button"
          class="mode-item {searchMode === modeId ? 'is-active' : ''}"
          onclick={() => selectMode(modeId)}
          role="option"
          aria-selected={searchMode === modeId}
        >
          <span class="mode-item-title">{getSearchLabel(modeId)}</span>
          <span class="mode-item-desc">{getSearchDesc(modeId)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mode-trigger {
    gap: 0.35rem;
  }

  .mode-trigger.is-deep,
  .mode-trigger.is-max {
    color: var(--foreground);
    font-weight: 600;
  }

  .mode-menu {
    padding: 0.3rem;
  }

  .mode-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    width: 100%;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    padding: 0.45rem 0.55rem;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .mode-item:hover {
    background: var(--muted);
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
    color: var(--muted-foreground);
    font-size: 0.68rem;
    font-weight: 450;
    line-height: 1.3;
  }
</style>
