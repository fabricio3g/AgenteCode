<svelte:options runes={true} />

<!--
  The three dictation models — Fast, Balanced, Best — as quiet cards.
  `select` mode (the mic's first-run popover) is a radio group; `manage` mode
  (Settings → Voice) adds Download / Use / Remove on each card.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Check } from 'lucide-svelte';
  import { formatBytes } from '$lib/utils/format';
  import { Button } from '$lib/components/ui';
  import type { SpeechModel } from './speech-models';

  let {
    models,
    mode = 'select',
    selected = $bindable(''),
    busy = '',
    progress = 0,
    ondownload,
    onuse,
    onremove
  }: {
    models: SpeechModel[];
    mode?: 'select' | 'manage';
    selected?: string;
    /** Quality being downloaded, if any. */
    busy?: string;
    progress?: number;
    ondownload?: (quality: string) => void;
    onuse?: (quality: string) => void;
    onremove?: (quality: string) => void;
  } = $props();
</script>

<div class="picker" role={mode === 'select' ? 'radiogroup' : 'list'}>
  {#each models as model (model.quality)}
    {@const isSelected = mode === 'select' ? selected === model.quality : model.inUse}
    <svelte:element
      this={mode === 'select' ? 'button' : 'div'}
      type={mode === 'select' ? 'button' : undefined}
      role={mode === 'select' ? 'radio' : 'listitem'}
      aria-checked={mode === 'select' ? isSelected : undefined}
      class="option"
      class:on={isSelected}
      onclick={mode === 'select' ? () => (selected = model.quality) : undefined}
    >
      {#if mode === 'select'}<span class="radio" aria-hidden="true"></span>{/if}
      <span class="text">
        <span class="name">
          {$t(`voice.tier.${model.tier}`)}
          {#if model.recommended}<span class="chip">{$t('voice.tier.recommended')}</span>{/if}
          {#if mode === 'manage' && model.inUse}<span class="chip good"><Check class="size-2.5" />{$t('voice.tier.inUse')}</span>{/if}
        </span>
        <span class="meta">
          {busy === model.quality
            ? `${$t('voice.tier.downloading')} · ${Math.round(progress)}%`
            : [formatBytes(model.bytes), $t(`voice.tier.${model.tier}Hint`), model.installed && mode === 'select' ? $t('voice.tier.installed') : ''].filter(Boolean).join(' · ')}
        </span>
        {#if busy === model.quality}
          <span class="bar" aria-hidden="true"><span style:width={`${Math.max(3, progress)}%`}></span></span>
        {/if}
      </span>
      {#if mode === 'manage'}
        <span class="actions">
          {#if !model.installed}
            <Button variant="outline" size="sm" disabled={!!busy} onclick={() => ondownload?.(model.quality)}>{$t('voice.tier.download')}</Button>
          {:else if !model.inUse}
            <Button variant="outline" size="sm" onclick={() => onuse?.(model.quality)}>{$t('voice.tier.use')}</Button>
          {/if}
          {#if model.installed && model.removable && !model.inUse}
            <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={() => onremove?.(model.quality)}>{$t('voice.tier.remove')}</Button>
          {/if}
        </span>
      {/if}
    </svelte:element>
  {/each}
  {#if mode === 'manage'}<p class="license">{$t('voice.tier.license')}</p>{/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .option {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.75rem;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--foreground);
    text-align: left;
    transition: border-color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }

  button.option:hover {
    background: var(--surface-hover);
  }

  .option.on {
    background: var(--muted);
  }

  .radio {
    width: 0.9rem;
    height: 0.9rem;
    flex-shrink: 0;
    border: 1.5px solid var(--border-hover, var(--border));
    border-radius: 50%;
    transition: border-width var(--motion-fast) var(--motion-ease);
  }

  .option.on .radio {
    border: 4px solid var(--foreground);
  }

  .text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.1rem;
  }

  .name {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .meta {
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0 0.45rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .chip.good {
    background: var(--accent-green-bg);
    color: var(--accent-green-text);
  }

  .bar {
    display: block;
    height: 3px;
    margin-top: 0.3rem;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
  }

  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--foreground);
    transition: width 200ms var(--motion-ease);
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  .license {
    margin: 0.15rem 0 0;
    font-size: 0.7rem;
    color: var(--muted-foreground);
  }
</style>
