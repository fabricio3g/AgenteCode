<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the
  level's name; it opens a short menu of the levels this model supports,
  each with one line on what it means — the pattern agent apps settle on.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Menu, MenuItem } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { effortBars } from './reasoning-effort';

  let open = $state(false);
  const capabilities = $derived(appStore.reasoningCapabilities);
  const visible = $derived(capabilities.supported && capabilities.source !== 'unknown' && capabilities.levels.length > 1);
  const modelDefault = $derived(appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : 'auto');
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const current = $derived(levels.includes(appStore.reasoningLevel) ? appStore.reasoningLevel : null);

  function labelFor(level: ReasoningLevel | null): string {
    if (level !== null) return $t(`composer.thinking.level.${level}`);
    return modelDefault === 'auto'
      ? $t('composer.thinking.level.auto')
      : $t('composer.thinking.modelDefault', { values: { level: $t(`composer.thinking.level.${modelDefault}`) } });
  }

  function hintFor(level: ReasoningLevel | null): string {
    return $t(`composer.thinking.hint.${level ?? 'auto'}`, { default: '' });
  }
</script>

{#snippet meter(level: ReasoningLevel | null)}
  {@const filled = effortBars(level)}
  <span class="meter" class:is-auto={level === null} aria-hidden="true">
    {#each [1, 2, 3, 4] as bar (bar)}<span class:is-on={bar <= filled}></span>{/each}
  </span>
{/snippet}

{#if visible}
  <Menu bind:open placement="top-start" minWidth="14rem" label={$t('composer.thinking.title')}>
    {#snippet trigger(props)}
      <button type="button" class="thinking-trigger" class:is-open={open} aria-label={$t('composer.thinking.trigger', { values: { level: labelFor(current) } })} title={$t('composer.thinking.title')} {...props}>
        {@render meter(current)}
        <span>{labelFor(current)}</span>
      </button>
    {/snippet}
    <p class="menu-title">{$t('composer.thinking.title')}</p>
    {#each levels as level (level)}
      <MenuItem active={current === level} onselect={() => { appStore.setReasoningLevel(level); open = false; }}>
        {@render meter(level)}
        <span class="ui-menu-item-text">
          <span class="truncate">{labelFor(level)}</span>
          {#if hintFor(level)}<span class="ui-menu-item-hint">{hintFor(level)}</span>{/if}
        </span>
      </MenuItem>
    {/each}
  </Menu>
{/if}

<style>
  .thinking-trigger {
    display: inline-flex;
    height: 26px;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.5rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 12px;
    white-space: nowrap;
  }

  .thinking-trigger:hover,
  .thinking-trigger.is-open {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .thinking-trigger:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  /* Four rising bars, filled to the level: reads as "effort" at a glance. */
  .meter {
    display: inline-flex;
    height: 10px;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 1.5px;
  }

  .meter span {
    width: 2.5px;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.25;
  }

  .meter span:nth-child(1) { height: 4px; }
  .meter span:nth-child(2) { height: 6px; }
  .meter span:nth-child(3) { height: 8px; }
  .meter span:nth-child(4) { height: 10px; }
  .meter span.is-on { opacity: 1; }
  .meter.is-auto span { opacity: 0.5; }

  .menu-title {
    padding: 0.25rem 0.625rem 0.375rem;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
  }
</style>
