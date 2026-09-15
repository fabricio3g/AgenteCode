<svelte:options runes={true} />

<script lang="ts">
  import { Brain, ChevronDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { Menu, MenuItem } from '$lib/components/ui';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';

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

  const modelDefault = $derived(appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : 'auto');
  const autoLabel = $derived(modelDefault === 'auto' ? 'Auto' : `Auto · ${modelDefault === 'on' ? 'On' : 'Off'}`);
  const currentLabel = $derived(currentLevel ? labelFor(currentLevel) : autoLabel);
  const triggerTitle = $derived(currentLevel
    ? `Thinking: ${currentLabel}. Overrides the model default for this chat.`
    : `Thinking: ${autoLabel}. Uses the model default. ${SOURCE_TITLES[capabilities.source] || ''}`);

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
      <button type="button" class="thinking-trigger" class:is-open={open} title={triggerTitle} aria-label={`Thinking: ${currentLabel}`} {...props}>
        <Brain class="size-3.5 shrink-0" />
        <span class="truncate">Thinking · {currentLabel}</span>
        <ChevronDown class="size-3 shrink-0 transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
    {/snippet}

    <MenuItem
      label={autoLabel}
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

<style>
  /* Matches the On Device model chip beside it: same height, white fill,
     hairline border. The old aui-pill (muted fill, taller) read as selected. */
  .thinking-trigger {
    display: inline-flex;
    height: 2rem;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    padding: 0 0.625rem;
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .thinking-trigger:hover,
  .thinking-trigger.is-open {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--muted);
    color: var(--foreground);
  }

  .thinking-trigger:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }
</style>
