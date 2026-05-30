<svelte:options runes={true} />

<script lang="ts">
  import { Bot, ChevronDown, MessageSquare, Plus } from 'lucide-svelte';
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
    aria-haspopup="menu"
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
      class="mode-selector-menu absolute bottom-full z-[200] mb-1 w-64 origin-bottom overflow-hidden rounded-2xl border bg-[var(--surface)] p-1.5"
      transition:flyAndScale={{ y: -4, start: 0.96, duration: 150 }}
      role="menu"
    >
      <div class="mode-options space-y-1">
        <div class="menu-section-label px-2 pb-1 pt-1">Mode</div>
        <button
          class="mode-menu-item {composerMode === 'chat' ? 'is-active' : ''}"
          onclick={() => selectMode('chat')}
          role="menuitemradio"
          aria-checked={composerMode === 'chat'}
      >
        <span class="item-icon"><MessageSquare class="h-4 w-4" /></span>
        <span class="min-w-0 flex-1">
          <span class="item-title">{getModeLabel('chat')}</span>
          <span class="item-desc">Normal conversation and quick answers.</span>
        </span>
      </button>

      <button
        class="mode-menu-item {composerMode === 'agent' ? 'is-active' : ''}"
        onclick={() => selectMode('agent')}
        role="menuitemradio"
        aria-checked={composerMode === 'agent'}
      >
        <span class="item-icon"><Bot class="h-4 w-4" /></span>
        <span class="min-w-0 flex-1">
          <span class="item-title">{getModeLabel('agent')}</span>
          <span class="item-desc">Use tools and longer task execution.</span>
        </span>
      </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .mode-selector-trigger {
    border-radius: 999px;
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

  .plus-mark {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
  }

  .mode-selector-menu {
    border-color: color-mix(in srgb, #dbe0ff 38%, var(--border) 62%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      0 18px 36px rgba(18, 22, 46, 0.24);
  }

  .menu-section-label {
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .mode-menu-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.65rem;
    border: 1px solid transparent;
    border-radius: 0.8rem;
    padding: 0.55rem 0.65rem;
    text-align: left;
    color: var(--text-secondary);
    background: transparent;
    transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.14s ease;
  }

  .mode-menu-item:hover:not(:disabled),
  .mode-menu-item.is-active {
    color: var(--text);
    background: var(--surface-hover);
    border-color: color-mix(in srgb, var(--border) 74%, transparent);
  }

  .mode-menu-item:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .item-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.85rem;
    height: 1.85rem;
    flex-shrink: 0;
    border-radius: 0.65rem;
    background: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text-secondary);
  }

  .mode-menu-item.is-active .item-icon {
    background: color-mix(in srgb, #717CE2 18%, transparent);
    color: #717CE2;
  }

  .item-title,
  .item-desc {
    display: block;
  }

  .item-title {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
  }

  .item-desc {
    margin-top: 0.1rem;
    color: var(--text-tertiary);
    font-size: 11px;
    line-height: 1.25;
  }
</style>
