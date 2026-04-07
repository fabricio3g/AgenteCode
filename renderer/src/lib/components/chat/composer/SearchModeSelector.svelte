<svelte:options runes={true} />

<script lang="ts">
  import { Search, Globe, Database, XCircle, Check, ChevronDown, ChevronUp } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const searchMode = $derived(appStore.searchMode);

  type SearchModeId = 'chat' | 'search' | 'deep' | 'max';

  const searchModeIds: SearchModeId[] = ['chat', 'search', 'deep', 'max'];

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);
  let dropdownPos = $state({ top: 0, bottom: 0, left: 0, openUp: false });
  const dropdownStyle = $derived(
    dropdownPos.openUp
      ? `bottom:${dropdownPos.bottom}px; left:${dropdownPos.left}px; z-index:200; min-width: 160px;`
      : `top:${dropdownPos.top}px; left:${dropdownPos.left}px; z-index:200; min-width: 160px;`
  );

  const currentModeId = $derived(searchModeIds.find(id => id === searchMode) || searchModeIds[0]);

  function getSearchLabel(id: SearchModeId): string {
    const labels = {
      chat: $t('composer.searchOff'),
      search: $t('composer.webSearch'),
      deep: $t('composer.deepSearch'),
      max: $t('composer.maxSearch')
    };
    return labels[id] || id;
  }

  function getSearchIcon(id: SearchModeId) {
    const icons = {
      chat: XCircle,
      search: Search,
      deep: Globe,
      max: Database
    };
    return icons[id] || Search;
  }

  function getSearchDescription(id: SearchModeId): string {
    const descriptions = {
      chat: $t('composer.searchOffDesc'),
      search: $t('composer.webSearchDesc'),
      deep: $t('composer.deepSearchDesc'),
      max: $t('composer.maxSearchDesc')
    };
    return descriptions[id] || '';
  }

  function updateDropdownPos() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const menuHeight = 208;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuHeight && rect.top > spaceBelow;
    dropdownPos = openUp
      ? { top: 0, bottom: Math.max(8, window.innerHeight - rect.top + 4), left: rect.left, openUp: true }
      : { top: rect.bottom + 4, bottom: 0, left: rect.left, openUp: false };
  }

  function toggleDropdown() {
    if (dropdownOpen) {
      dropdownOpen = false;
      return;
    }
    updateDropdownPos();
    dropdownOpen = true;
  }

  function selectMode(mode: 'chat' | 'search' | 'deep' | 'max') {
    appStore.setSearchMode(mode);
    dropdownOpen = false;
  }

  $effect(() => {
    if (!dropdownOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!triggerEl?.contains(target) && !dropdownEl?.contains(target)) {
        dropdownOpen = false;
      }
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        dropdownOpen = false;
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<button
  bind:this={triggerEl}
  class="selector-trigger flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium transition"
  class:active={searchMode !== 'chat'}
  onclick={toggleDropdown}
  aria-haspopup="listbox"
  aria-expanded={dropdownOpen}
>
  <svelte:component this={getSearchIcon(currentModeId)} class="h-4 w-4" />
  <span>{getSearchLabel(currentModeId)}</span>
  {#if dropdownPos.openUp}
    <ChevronUp class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  {:else}
    <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  {/if}
</button>

{#if dropdownOpen}
  <div
    bind:this={dropdownEl}
    class="selector-dropdown fixed overflow-hidden"
    style={dropdownStyle}
    transition:fly={{ y: dropdownPos.openUp ? 4 : -4, duration: 120 }}
    role="listbox"
    aria-label={$t('composer.selectSearchMode')}
  >
    <div class="p-1">
      {#each searchModeIds as modeId (modeId)}
        {@const Icon = getSearchIcon(modeId)}
        <button
          class="selector-option flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition"
          class:selected={searchMode === modeId}
          onclick={() => selectMode(modeId)}
          role="option"
          aria-selected={searchMode === modeId}
        >
          <Icon class="h-4 w-4" />
          <span class="flex-1">{getSearchLabel(modeId)}</span>
          {#if searchMode === modeId}
            <Check class="h-3.5 w-3.5 text-[var(--primary)]" />
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .selector-trigger {
    color: var(--text-secondary);
    background: transparent;
  }

  .selector-trigger:hover {
    background: var(--surface-highlight);
    color: var(--text);
  }

  .selector-trigger.active {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .selector-dropdown {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-l);
  }

  .selector-option {
    color: var(--text);
    background: transparent;
  }

  .selector-option:hover {
    background: var(--surface-highlight);
  }

  .selector-option.selected {
    background: var(--surface-highlight);
  }
</style>
