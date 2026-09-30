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
      <div class="thinking-card" style:--pct={`${levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0}%`}>
        <div class="head">
          <label for={`${id}-slider`}>{$t('composer.thinking.title')}</label>
          <span class="value">{currentLabel}</span>
        </div>
        <div class="track-wrap">
          <div class="rail" aria-hidden="true"></div>
          <div class="ticks" aria-hidden="true">
            {#each levels as level, tick (level)}<span class:is-on={tick <= index}></span>{/each}
          </div>
          <input id={`${id}-slider`} type="range" min="0" max={levels.length - 1} step="1" value={index}
            aria-valuetext={currentLabel}
            oninput={(event) => appStore.setReasoningLevel(levels[Number(event.currentTarget.value)])} />
        </div>
        <div class="ends" aria-hidden="true">
          <span>{labelFor(levels[0])}</span>
          <span>{labelFor(levels[levels.length - 1])}</span>
        </div>
      </div>
    </ComposerCard>
  {/if}
{/if}

<style>
  .thinking-trigger { height: 26px; flex-shrink: 0; padding: 0 0.375rem; background: transparent; border: 0; border-radius: var(--radius-full); color: var(--muted-foreground); font-size: 12px; white-space: nowrap; cursor: pointer; }
  .thinking-trigger:hover, .thinking-trigger.is-open { background: var(--muted); color: var(--foreground); }
  .thinking-trigger:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  .thinking-card { width: 13.5rem; display: grid; gap: 0.5rem; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  label { color: var(--muted-foreground); font-size: 11.5px; }
  .value { color: var(--foreground); font-size: 12px; font-weight: 500; }

  /* A slim track that fills up to the chosen level, one dot per level. */
  .track-wrap { position: relative; height: 1rem; }
  .rail {
    position: absolute;
    inset: 50% 0 auto;
    height: 4px;
    transform: translateY(-50%);
    border-radius: 9999px;
    background: linear-gradient(to right, var(--foreground) var(--pct), var(--muted) var(--pct));
  }
  .ticks {
    position: absolute;
    inset: 50% 5px auto;
    display: flex;
    justify-content: space-between;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .ticks span { width: 4px; height: 4px; border-radius: 9999px; background: var(--border-hover); }
  .ticks span.is-on { background: var(--background); }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  input::-webkit-slider-runnable-track {
    height: 4px;
    background: transparent;
  }
  input::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border-radius: 9999px;
    background: var(--popover);
    border: 2px solid var(--foreground);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    position: relative;
    z-index: 1;
  }
  input:focus-visible { outline: none; }
  input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent); }
  .ends { display: flex; justify-content: space-between; color: var(--muted-foreground); font-size: 11px; }
</style>
