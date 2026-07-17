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
      case 'off':
        return 'Off';
      case 'none':
        return 'None';
      case 'minimal':
        return 'Minimal';
      case 'low':
        return 'Low';
      case 'medium':
        return 'Medium';
      case 'high':
        return 'High';
      case 'max':
        return 'Max';
      case 'xhigh':
        return 'X-High';
      case 'enabled':
        return 'On';
      case 'disabled':
        return 'Off';
      case 'on':
        return 'On';
      default:
        return String(level);
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
      type="button"
      class="aui-select-trigger"
      onclick={toggleDropdown}
      aria-haspopup="listbox"
      aria-expanded={dropdownOpen}
      title={
        capabilities.source === 'sdk'
          ? 'Reasoning supported by provider SDK'
          : capabilities.source === 'api'
            ? 'Reasoning supported by provider API'
            : capabilities.source === 'metadata'
              ? 'Reasoning supported by model metadata'
              : 'Reasoning level'
      }
    >
      <Brain class="size-3.5" />
      <span>{currentLabel}</span>
      <ChevronDown class={`size-3 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
    </button>

    {#if dropdownOpen}
      <div
        bind:this={dropdownEl}
        class="aui-menu absolute bottom-full z-[200] mb-1 min-w-[10rem] origin-bottom"
        transition:flyAndScale={{ y: -4, start: 0.95, duration: 150 }}
        role="listbox"
      >
        {#each capabilities.levels as level (level)}
          <button
            type="button"
            class="aui-menu-item {currentLevel === level ? 'is-active' : ''}"
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
