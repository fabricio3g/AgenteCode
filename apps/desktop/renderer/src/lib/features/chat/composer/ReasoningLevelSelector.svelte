<svelte:options runes={true} />
<script lang="ts">
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';

  let open = $state(false);
  let anchor = $state<HTMLButtonElement>();
  const id = $props.id();
  const capabilities = $derived(appStore.reasoningCapabilities);
  const visible = $derived(capabilities.supported && capabilities.source !== 'unknown' && capabilities.levels.length > 1);
  const modelDefault = $derived(appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : 'auto');
  const autoLabel = $derived(modelDefault === 'auto' ? $t('composer.thinking.level.auto')
    : $t('composer.thinking.modelDefault', { values: { level: labelFor(modelDefault) } }));
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const index = $derived(Math.max(0, levels.indexOf(appStore.reasoningLevel)));
  const currentLabel = $derived(labelFor(levels[index]));
  function labelFor(level: ReasoningLevel | null): string {
    return level === null ? autoLabel : $t(`composer.thinking.level.${level}`);
  }
</script>

{#if visible}
  <button bind:this={anchor} type="button" class="thinking-trigger" class:is-open={open}
    aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
    onclick={() => (open = !open)}>{$t('composer.thinking.trigger', { values: { level: currentLabel } })}</button>
  {#if open}
    <ComposerCard {anchor} {id} label={$t('composer.thinking.title')} onclose={() => (open = false)}>
      <div class="thinking-card">
        <label for={`${id}-slider`}>{$t('composer.thinking.title')}</label>
        <input id={`${id}-slider`} type="range" min="0" max={levels.length - 1} step="1" value={index}
          aria-valuetext={currentLabel} list={`${id}-ticks`}
          oninput={(event) => appStore.setReasoningLevel(levels[Number(event.currentTarget.value)])} />
        <datalist id={`${id}-ticks`}>{#each levels as level, tick (level)}<option value={tick} label={labelFor(level)}></option>{/each}</datalist>
        <div class="tick-labels" style:grid-template-columns={`repeat(${levels.length}, minmax(0, 1fr))`} aria-hidden="true">
          {#each levels as level (level)}<span>{labelFor(level)}</span>{/each}
        </div>
      </div>
    </ComposerCard>
  {/if}
{/if}

<style>
  .thinking-trigger { height: 26px; flex-shrink: 0; padding: 0 0.375rem; background: transparent; border: 0; border-radius: var(--radius-full); color: var(--muted-foreground); font-size: 12px; white-space: nowrap; cursor: pointer; }
  .thinking-trigger:hover, .thinking-trigger.is-open { background: var(--muted); color: var(--foreground); }
  .thinking-trigger:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .thinking-card { width: min(25rem, calc(100vw - 3rem)); display: grid; gap: 0.5rem; }
  label { font-weight: 500; }
  input { width: 100%; accent-color: var(--ring); cursor: pointer; }
  .tick-labels { display: grid; gap: 0.25rem; color: var(--muted-foreground); font-size: 11px; text-align: center; }
  .tick-labels span { overflow-wrap: anywhere; }
  .tick-labels span:first-child { text-align: start; }
  .tick-labels span:last-child { text-align: end; }
</style>
