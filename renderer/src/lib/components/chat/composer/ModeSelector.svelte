<svelte:options runes={true} />

<script lang="ts">
  import { Plus, MessageSquare, Bot, Presentation, Check, ChevronDown } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const composerMode = $derived(appStore.composerMode);

  interface ModeOption {
    id: 'chat' | 'agent' | 'slides';
    icon: typeof MessageSquare;
  }

  const modeOptionsIds: ModeOption['id'][] = ['chat', 'agent', 'slides'];

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);
  let dropdownPos = $state({ bottom: 0, left: 0 });

  const currentModeId = $derived(modeOptionsIds.find(id => id === composerMode) || modeOptionsIds[0]);

  function getModeLabel(id: ModeOption['id']): string {
    const labels = {
      chat: $t('composer.modeChat'),
      agent: $t('composer.modeAgent'),
      slides: $t('composer.modeSlides')
    };
    return labels[id] || id;
  }

  function getModeIcon(id: ModeOption['id']) {
    const icons = {
      chat: MessageSquare,
      agent: Bot,
      slides: Presentation
    };
    return icons[id] || MessageSquare;
  }

  function updateDropdownPos() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    dropdownPos = {
      bottom: window.innerHeight - rect.top + 4,
      left: rect.left
    };
  }

  function toggleDropdown() {
    if (dropdownOpen) {
      dropdownOpen = false;
      return;
    }
    updateDropdownPos();
    dropdownOpen = true;
  }

  function selectMode(mode: 'chat' | 'agent' | 'slides') {
    appStore.setComposerMode(mode);
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
  onclick={toggleDropdown}
  aria-haspopup="listbox"
  aria-expanded={dropdownOpen}
>
  <Plus class="h-4 w-4" />
  <span>{getModeLabel(currentModeId)}</span>
  <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
</button>

{#if dropdownOpen}
  <div
    bind:this={dropdownEl}
    class="selector-dropdown fixed overflow-hidden"
    style="bottom:{dropdownPos.bottom}px; left:{dropdownPos.left}px; z-index:200; min-width: 140px;"
    transition:fly={{ y: 4, duration: 120 }}
    role="listbox"
    aria-label={$t('composer.selectMode')}
  >
    <div class="p-1">
      {#each modeOptionsIds as optionId (optionId)}
        {@const Icon = getModeIcon(optionId)}
        <button
          class="selector-option flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition"
          class:selected={composerMode === optionId}
          onclick={() => selectMode(optionId)}
          role="option"
          aria-selected={composerMode === optionId}
        >
          <Icon class="h-4 w-4" />
          <span class="flex-1">{getModeLabel(optionId)}</span>
          {#if composerMode === optionId}
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
