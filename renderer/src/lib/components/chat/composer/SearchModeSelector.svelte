<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, WifiOff } from 'lucide-svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const searchMode = $derived(appStore.searchMode);

  type SearchModeId = 'chat' | 'search' | 'deep' | 'max';

  const searchModeIds: SearchModeId[] = ['chat', 'search', 'deep', 'max'];

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);

  const currentModeId = $derived(searchModeIds.find(id => id === searchMode) || searchModeIds[0]);

  function getSearchLabel(id: SearchModeId): string {
    const labels: Record<SearchModeId, string> = {
      chat: $t('composer.searchOff'),
      search: $t('composer.webSearch'),
      deep: $t('composer.deepSearch'),
      max: $t('composer.maxSearch')
    };
    return labels[id] || id;
  }

  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
  }

  function selectMode(mode: 'chat' | 'search' | 'deep' | 'max') {
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
    class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] {dropdownOpen ? 'rounded-b-lg border border-t-0 border-[var(--border)] bg-[var(--surface)]' : 'rounded-lg border border-[var(--border)] bg-[var(--surface)]'}"
    onclick={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
  >
    {#if currentModeId === 'chat'}
      <WifiOff class="search-selector-icon h-3.5 w-3.5" />
    {:else}
      {getSearchLabel(currentModeId)}
    {/if}
    <ChevronDown class={`search-selector-icon h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="absolute bottom-full z-[200] min-w-[140px] origin-bottom overflow-hidden rounded-t-lg border border-[var(--border)] bg-[var(--surface)] py-0.5"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each searchModeIds as modeId (modeId)}
        <button
          class="flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hover)] {searchMode === modeId ? 'bg-[var(--surface-hover)] font-medium text-[var(--text)]' : 'text-[var(--text-secondary)]'}"
          onclick={() => selectMode(modeId)}
          role="option"
          aria-selected={searchMode === modeId}
        >
          {getSearchLabel(modeId)}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search-selector-icon {
    color: rgb(10, 53, 104);
  }

  :global(.dark) .search-selector-icon {
    color: #ffffff;
  }
</style>
