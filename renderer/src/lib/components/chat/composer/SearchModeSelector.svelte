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
    class="search-selector-trigger inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:opacity-90 {dropdownOpen ? 'open rounded-b-lg border-t-0' : 'rounded-lg'}"
    onclick={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
  >
    {#if currentModeId === 'chat'}
      <WifiOff class="h-3.5 w-3.5" />
    {:else}
      {getSearchLabel(currentModeId)}
    {/if}
    <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="search-selector-menu absolute bottom-full z-[200] min-w-[140px] origin-bottom overflow-hidden rounded-t-lg border bg-[var(--surface)] py-0.5"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each searchModeIds as modeId (modeId)}
        <button
          class="flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hover)] {searchMode === modeId ? 'font-medium text-white search-selector-active' : 'text-[var(--text-secondary)]'}"
          style={searchMode === modeId ? 'background: #717CE2; color: #ffffff;' : undefined}
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
  .search-selector-trigger {
    color: var(--text);
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(245, 245, 245, 0.95) 0%, rgba(223, 223, 223, 0.94) 44%, rgba(196, 196, 196, 0.92) 52%, rgba(232, 232, 232, 0.95) 100%) border-box;
    border: 1px solid transparent;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      var(--shadow-xs);
  }

  .search-selector-menu {
    border-color: color-mix(in srgb, #dbe0ff 45%, var(--border) 55%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 10px 20px rgba(18, 22, 46, 0.22);
  }

  :global(.search-selector-trigger svg) {
    color: var(--text);
  }

  :global(.dark) .search-selector-trigger {
    color: var(--text);
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.18) 38%, rgba(0, 0, 0, 0.45) 52%, rgba(255, 255, 255, 0.24) 100%) border-box;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.14),
      inset 0 -1px 0 rgba(0, 0, 0, 0.35),
      var(--shadow-xs);
  }

  .search-selector-active {
    color: #ffffff;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.2);
  }
</style>
