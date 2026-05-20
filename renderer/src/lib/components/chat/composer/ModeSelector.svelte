<svelte:options runes={true} />

<script lang="ts">
  import { Plus, ChevronDown } from 'lucide-svelte';
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
      chat: $t('composer.modeChat'),
      agent: $t('composer.modeAgent')
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
    class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90 {dropdownOpen ? 'rounded-b-lg border border-t-0 border-[var(--border)]' : 'rounded-lg border border-[var(--border)]'}"
    style="background: #09305D;"
    onclick={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={dropdownOpen}
  >
    <Plus class="h-3.5 w-3.5" />
    {getModeLabel(currentModeId)}
    <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
  </button>

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="absolute bottom-full z-[200] min-w-[130px] origin-bottom overflow-hidden rounded-t-lg border border-[var(--border)] bg-[var(--surface)] py-0.5"
      transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
      role="listbox"
    >
      {#each modeOptionsIds as optionId (optionId)}
        <button
          class="flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hover)] {composerMode === optionId ? 'font-medium text-white' : 'text-[var(--text-secondary)]'}"
          style={composerMode === optionId ? 'background: #09305D;' : undefined}
          onclick={() => selectMode(optionId)}
          role="option"
          aria-selected={composerMode === optionId}
        >
          {getModeLabel(optionId)}
        </button>
      {/each}
    </div>
  {/if}
</div>
