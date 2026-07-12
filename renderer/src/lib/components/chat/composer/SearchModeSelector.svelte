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
    class="aui-select-trigger"
    onclick={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
  >
    {#if currentModeId === 'chat'}
      <WifiOff class="size-3.5" />
    {:else}
      <span>{getSearchLabel(currentModeId)}</span>
    {/if}
    <ChevronDown class={`size-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="aui-menu absolute bottom-full z-[200] mb-1 min-w-[10rem] origin-bottom"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each searchModeIds as modeId (modeId)}
        <button
          type="button"
          class="aui-menu-item {searchMode === modeId ? 'is-active' : ''}"
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
