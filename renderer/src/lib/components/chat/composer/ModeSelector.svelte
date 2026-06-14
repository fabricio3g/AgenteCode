<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Plus } from 'lucide-svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const composerMode = $derived(appStore.composerMode);
  const modeOptionsIds: Array<'chat' | 'agent'> = ['chat', 'agent'];

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);

  const currentModeId = $derived(modeOptionsIds.find(id => id === composerMode) || modeOptionsIds[0]);

  function getModeLabel(id: 'chat' | 'agent'): string {
    const labels = {
      chat: $t('composer.modeChat') || 'Chat',
      agent: $t('composer.modeAgent') || 'Agent'
    };
    return labels[id] || id;
  }

  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
  }

  function selectMode(mode: 'chat' | 'agent') {
    appStore.setComposerMode(mode);
    dropdownOpen = false;
  }

  $effect(() => {
    if (!dropdownOpen || !triggerEl || !dropdownEl) return;
    const trigger = triggerEl;
    const dropdown = dropdownEl;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!trigger.contains(target) && !dropdown.contains(target)) dropdownOpen = false;
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
    class="mode-selector-trigger inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition {dropdownOpen ? 'is-open' : ''}"
    onclick={toggleDropdown}
      aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
    title="Add mode or tool"
  >
    <span class="plus-mark inline-flex items-center justify-center">
      <Plus class="h-3.5 w-3.5" />
    </span>
    <span>{getModeLabel(currentModeId)}</span>
    <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="mode-selector-menu absolute bottom-full z-[200] min-w-[140px] origin-bottom overflow-hidden rounded-t-lg border bg-[var(--surface)] py-0.5"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each modeOptionsIds as modeId (modeId)}
        <button
          class="flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hover)] {composerMode === modeId ? 'font-medium text-white mode-selector-active' : 'text-[var(--text-secondary)]'}"
          style={composerMode === modeId ? 'background: #717CE2; color: #ffffff;' : undefined}
          onclick={() => selectMode(modeId)}
          role="option"
          aria-selected={composerMode === modeId}
        >
          {getModeLabel(modeId)}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mode-selector-trigger {
    border-radius: 0.5rem;
    color: #fff;
    background: linear-gradient(180deg, #818af0 0%, #717CE2 52%, #626edc 100%);
    border: 1px solid color-mix(in srgb, #dbe0ff 58%, #5f69c9 42%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      inset 0 -1px 0 rgba(0, 0, 0, 0.2),
      0 0 0 1px rgba(226, 231, 255, 0.18);
  }

  .mode-selector-trigger:hover,
  .mode-selector-trigger.is-open {
    filter: brightness(1.03);
  }

  .mode-selector-trigger.is-open {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-bottom-left-radius: 0.5rem;
    border-bottom-right-radius: 0.5rem;
  }

  .plus-mark {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
  }

  .mode-selector-menu {
    border-color: color-mix(in srgb, #dbe0ff 38%, var(--border) 62%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 10px 20px rgba(18, 22, 46, 0.22);
  }

  .mode-selector-active {
    color: #ffffff;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.2);
  }
</style>
