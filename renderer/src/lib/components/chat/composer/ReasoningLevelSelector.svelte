<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Brain } from 'lucide-svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';

  const capabilities = $derived(appStore.reasoningCapabilities);
  const currentLevel = $derived(appStore.reasoningLevel);

  let triggerEl: HTMLButtonElement | undefined = $state();
  let dropdownEl: HTMLDivElement | undefined = $state();
  let dropdownOpen = $state(false);

  const visible = $derived(
    capabilities.supported &&
    capabilities.source !== 'unknown' &&
    capabilities.levels.length > 1
  );

  const currentLabel = $derived(currentLevel || 'off');

  function labelFor(level: ReasoningLevel): string {
    switch (level) {
      case 'off':       return 'Off';
      case 'none':      return 'None';
      case 'minimal':   return 'Minimal';
      case 'low':       return 'Low';
      case 'medium':    return 'Medium';
      case 'high':      return 'High';
      case 'xhigh':     return 'X-High';
      case 'enabled':   return 'On';
      case 'disabled':  return 'Off';
      case 'on':        return 'On';
      default:          return String(level);
    }
  }

  function selectLevel(level: ReasoningLevel) {
    appStore.setReasoningLevel(level === 'off' ? null : level);
    dropdownOpen = false;
  }

  function toggleDropdown() {
    if (!visible) return;
    dropdownOpen = !dropdownOpen;
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

{#if visible}
  <div class="relative inline-flex">
    <button
      bind:this={triggerEl}
      class="reasoning-selector-trigger inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-[var(--text)] transition hover:opacity-90"
      onclick={toggleDropdown}
      aria-haspopup="listbox"
      aria-expanded={dropdownOpen}
      title={capabilities.source === 'sdk'
        ? 'Reasoning supported by provider SDK'
        : capabilities.source === 'api'
          ? 'Reasoning supported by provider API'
          : capabilities.source === 'metadata'
            ? 'Reasoning supported by model metadata'
            : 'Reasoning level'}
    >
      <Brain class="h-3.5 w-3.5" />
      <span>{currentLabel}</span>
      <ChevronDown class={`h-3 w-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
    </button>

    {#if dropdownOpen}
      <div
        bind:this={dropdownEl}
        class="reasoning-selector-menu absolute bottom-full z-[200] min-w-[140px] origin-bottom overflow-hidden rounded-t-lg border bg-[var(--surface)] py-0.5"
        transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
        role="listbox"
      >
        {#each capabilities.levels as level (level)}
          <button
            type="button"
            class="reasoning-option flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hover)] {currentLevel === level ? 'reasoning-option-active font-medium text-white' : 'text-[var(--text-secondary)]'}"
            style={currentLevel === level ? 'background: #717CE2; color: #ffffff;' : undefined}
            onclick={() => selectLevel(level)}
            role="option"
            aria-selected={currentLevel === level}
          >
            {labelFor(level)}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .reasoning-selector-trigger {
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

  .reasoning-selector-menu {
    border-color: color-mix(in srgb, #dbe0ff 45%, var(--border) 55%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 10px 20px rgba(18, 22, 46, 0.22);
  }

  :global(.reasoning-selector-trigger svg) {
    color: var(--text);
  }

  :global(.dark) .reasoning-selector-trigger {
    color: var(--text);
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.18) 38%, rgba(0, 0, 0, 0.45) 52%, rgba(255, 255, 255, 0.24) 100%) border-box;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.14),
      inset 0 -1px 0 rgba(0, 0, 0, 0.35),
      var(--shadow-xs);
  }

  .reasoning-option-active {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.2);
  }
</style>