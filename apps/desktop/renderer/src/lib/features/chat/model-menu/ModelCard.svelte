<svelte:options runes={true} />

<!--
  The card beside the model menu: what decides a choice, for the row under the
  pointer or the arrow keys. A cloud model shows its window, output cap, prices
  and what it accepts (from the core's catalog); an on-device model shows its
  size, whether it fits, its quantization and its context per chat. It never
  takes focus or a click: the list stays the thing you work in.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import Portal from '$lib/components/ui/Portal.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import { Cpu } from '$lib/icons';
  import { getModelCard, formatPrice, formatTokens, type ModelCard } from '$lib/services/model-card';
  import type { CardTarget } from './model-menu';

  let { target, anchor }: { target: CardTarget | null; anchor: HTMLElement | null } = $props();

  let card = $state<ModelCard | null>(null);
  let loadingKey = '';

  $effect(() => {
    const current = target;
    card = null;
    if (!current || current.kind !== 'cloud') return;
    const key = `${current.provider}/${current.model}`;
    loadingKey = key;
    void getModelCard(current.provider, current.model).then((result) => {
      if (loadingKey === key) card = result;
    });
  });

  /**
   * Beside the open menu panels, never over them: right of all of them when
   * there is room, else left of all of them, its bottom on the row's bottom;
   * above them when the window is too narrow for either side.
   */
  const place = $derived.by(() => {
    if (!anchor) return null;
    const panels = [...document.querySelectorAll<HTMLElement>('.ui-menu-panel')].map((panel) => panel.getBoundingClientRect());
    const row = anchor.getBoundingClientRect();
    const left = Math.min(row.left, ...panels.map((box) => box.left));
    const right = Math.max(row.right, ...panels.map((box) => box.right));
    const width = 240;
    const gap = 8;
    const bottom = Math.max(6, window.innerHeight - row.bottom - 4);
    if (window.innerWidth - right - gap >= width + 6) return { left: right + gap, bottom };
    if (left - gap - width >= 6) return { left: left - gap - width, bottom };
    // A narrow window: no side has room, so the card sits above the menus.
    const top = Math.min(row.top, ...panels.map((box) => box.top));
    return { left: Math.max(6, Math.min(right - width, window.innerWidth - width - 6)), bottom: window.innerHeight - top + gap };
  });

  const inputs = $derived((card?.inputs ?? []).filter((kind) => kind !== 'text').map((kind) => (kind === 'file' ? 'pdf' : kind)));
  const missing = $derived(card ? ['image', 'audio', 'pdf'].filter((kind) => card!.inputs.length && !inputs.includes(kind)) : []);
  const perMillion = (value: number | null | undefined) => {
    const price = formatPrice(value, $t('modelPicker.card.free'));
    return price && value !== 0 ? $t('modelPicker.card.perMillion', { values: { price } }) : price;
  };
</script>

{#if target && place}
  <Portal>
    <aside class="model-card ui-float" style:left="{place.left}px" style:bottom="{place.bottom}px" aria-hidden="true">
      <header class="card-head">
        {#if target.kind === 'cloud'}<ProviderIcon provider={target.provider} size={14} />{:else}<Cpu class="size-3.5 text-muted-foreground" />{/if}
        <span class="card-name">{target.name}</span>
        <small>{target.kind === 'cloud' ? target.providerLabel : target.quantization ?? ''}</small>
      </header>

      {#if target.kind === 'cloud'}
        {#if card && (card.context || card.cost)}
          <dl class="card-kv">
            {#if card.context}<dt>{$t('modelPicker.card.context')}</dt><dd>{formatTokens(card.context)}</dd>{/if}
            {#if card.output}<dt>{$t('modelPicker.card.output')}</dt><dd>{formatTokens(card.output)}</dd>{/if}
            {#if card.cost?.input != null}<dt>{$t('modelPicker.card.input')}</dt><dd>{perMillion(card.cost.input)}</dd>{/if}
            {#if card.cost?.output != null}<dt>{$t('modelPicker.card.outputCost')}</dt><dd>{perMillion(card.cost.output)}</dd>{/if}
            {#if card.cost?.cacheRead}<dt>{$t('modelPicker.card.cache')}</dt><dd>{perMillion(card.cost.cacheRead)}</dd>{/if}
          </dl>
          <div class="card-caps">
            {#each inputs as kind (kind)}<span class="cap">{$t(`modelPicker.card.${kind}`, { default: kind })}</span>{/each}
            {#if card.tools}<span class="cap">{$t('modelPicker.card.tools')}</span>{/if}
            {#if card.reasoning}<span class="cap">{$t('modelPicker.card.reasoning')}</span>{/if}
            {#each missing as kind (kind)}<span class="cap is-off">{$t(`modelPicker.card.${kind}`)}</span>{/each}
          </div>
        {:else if card}
          <p class="card-note">{$t('modelPicker.card.unknown')}</p>
        {/if}
      {:else}
        <dl class="card-kv">
          {#if target.sizeGb}<dt>{$t('modelPicker.card.size')}</dt><dd>{target.sizeGb.toFixed(1)} GB</dd>{/if}
          <dt>{$t('modelPicker.card.memory')}</dt>
          <dd class="fit-{target.fit}">{target.fit === 'wont' ? $t('modelPicker.wontFit') : target.fit === 'tight' ? $t('modelPicker.tight') : target.fit === 'fits' ? $t('modelPicker.card.fits') : '—'}</dd>
          {#if target.context}<dt>{$t('modelPicker.card.context')}</dt><dd>{formatTokens(target.context)}</dd>{/if}
          {#if target.perChat}<dt></dt><dd class="dim">{$t('modelPicker.card.perChat', { values: { ctx: formatTokens(target.perChat) } })}</dd>{/if}
          <dt>{$t('modelPicker.card.input')}</dt><dd>{$t('modelPicker.card.free')}</dd>
        </dl>
        {#if target.tools}<div class="card-caps"><span class="cap">{$t('modelPicker.card.tools')}</span></div>{/if}
      {/if}
    </aside>
  </Portal>
{/if}

<style>
  .model-card {
    position: fixed;
    z-index: var(--z-menu);
    width: 240px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
    font-size: var(--text-xs);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .card-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .card-head small {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  .card-kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  .card-kv dt { color: var(--muted-foreground); }
  .card-kv dd {
    margin: 0;
    text-align: right;
    color: var(--foreground);
    font-variant-numeric: tabular-nums;
  }
  .card-kv dd.dim { color: var(--muted-foreground); }
  .card-kv dd.fit-wont { color: var(--error); }
  .card-kv dd.fit-tight { color: var(--warning); }
  .card-caps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .cap {
    padding: 0.0625rem 0.4375rem;
    border-radius: var(--radius-sm);
    background: var(--muted);
    color: var(--text-secondary);
  }
  .cap.is-off {
    color: var(--muted-foreground);
    text-decoration: line-through;
    opacity: 0.7;
  }
  .card-note {
    margin: 0;
    color: var(--muted-foreground);
  }
</style>
