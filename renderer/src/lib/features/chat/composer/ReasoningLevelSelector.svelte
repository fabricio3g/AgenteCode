<svelte:options runes={true} />

<script lang="ts">
  import { Brain, ChevronDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { Menu, MenuItem } from '$lib/components/ui';

  const LEVEL_LABELS: Partial<Record<ReasoningLevel, string>> = {
    off: 'Off',
    none: 'None',
    default: 'Default',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
    xhigh: 'X-High',
    enabled: 'On',
    disabled: 'Off',
    on: 'On'
  };

  const SOURCE_TITLES: Record<string, string> = {
    sdk: 'Reasoning supported by provider SDK',
    api: 'Reasoning supported by provider API',
    metadata: 'Reasoning supported by model metadata'
  };

  let open = $state(false);

  const capabilities = $derived(appStore.reasoningCapabilities);
  const currentLevel = $derived(appStore.reasoningLevel);

  // Only offered when a provider actually reported support for more than one
  // level — never inferred from the model name.
  const visible = $derived(
    capabilities.supported && capabilities.source !== 'unknown' && capabilities.levels.length > 1
  );

  const triggerTitle = $derived(SOURCE_TITLES[capabilities.source] || 'Reasoning level');

  function labelFor(level: ReasoningLevel): string {
    return LEVEL_LABELS[level] || String(level);
  }

  function select(level: ReasoningLevel | null) {
    // 'off' is a real level (dialects map it to "disable thinking"); only
    // Auto clears back to unset so the server default applies.
    appStore.setReasoningLevel(level);
    open = false;
  }
</script>

{#if visible}
  <Menu bind:open placement="top-start" minWidth="10rem" label="Reasoning level">
    {#snippet trigger(props)}
      <button type="button" class="aui-select-trigger aui-pill" title={triggerTitle} {...props}>
        <Brain class="size-3.5" />
        <span>{currentLevel ? labelFor(currentLevel) : 'Auto'}</span>
        <ChevronDown class="size-3 transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
    {/snippet}

    <MenuItem
      label="Auto"
      active={!currentLevel}
      onselect={() => select(null)}
    />
    {#each capabilities.levels as level (level)}
      <MenuItem
        label={labelFor(level)}
        active={currentLevel === level}
        onselect={() => select(level)}
      />
    {/each}
  </Menu>
{/if}
