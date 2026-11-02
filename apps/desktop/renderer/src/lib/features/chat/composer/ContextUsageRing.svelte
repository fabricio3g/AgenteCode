<svelte:options runes={true} />
<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';
  import { formatPricePerMillion } from '$lib/utils/money';

  import { t, locale } from 'svelte-i18n';
  import type { CodeSpend, ContextBreakdown } from '$shared/agente-protocol';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import ComposerStatus from '$lib/features/shared/composer/ComposerStatus.svelte';

  let { usedTokens, maxTokens, remaining, usagePercent, reservedTokens = 0, estimated = false,
    promptCostPerMillionUsd, completionCostPerMillionUsd, spend, showLabel = false, breakdown }: {
    estimated?: boolean;
    showLabel?: boolean;
    usedTokens: number;
    maxTokens: number;
    remaining?: number;
    usagePercent?: number;
    reservedTokens?: number;
    promptCostPerMillionUsd?: number;
    completionCostPerMillionUsd?: number;
    spend?: CodeSpend;
    breakdown?: ContextBreakdown;
  } = $props();
  let anchor = $state<HTMLButtonElement>();
  let open = $state(false);
  const id = $props.id();
  const max = $derived(Number.isFinite(maxTokens) ? Math.max(1, Math.floor(maxTokens)) : 1);
  const used = $derived(Number.isFinite(usedTokens) ? Math.max(0, Math.floor(usedTokens)) : 0);
  const percent = $derived(Math.max(0, Math.min(100, (Number.isFinite(usagePercent) ? usagePercent! : used / max * 100))));
  const percentLabel = $derived(percent > 0 && percent < 1 ? '<1' : Math.floor(percent).toString());
  const color = $derived(percent >= 95 ? 'var(--destructive)' : percent >= 80 ? 'var(--warning)' : 'var(--work-accent)');
  const circumference = 2 * Math.PI * 5.75;
  const label = $derived((estimated ? '~' : '') + $t('chat.context.usage', { values: { used: count(used), max: count(max), percent: percentLabel } }));
  function count(value: number) { return new Intl.NumberFormat($locale || 'en').format(Math.floor(value)); }
  // A rate per million tokens, through the same formatter the model cards use:
  // one model never shows two prices for the same token.
  const price = (value: number) => formatPricePerMillion(value, 'free');
  const sections = $derived(breakdown ? [
    { key: 'system', label: $t('chat.context.systemLabel'), value: breakdown.system },
    { key: 'messages', label: $t('chat.context.messagesLabel'), value: breakdown.messages },
    ...(breakdown.toolResults == null ? [] : [{ key: 'results', label: $t('chat.context.resultsLabel'), value: breakdown.toolResults }]),
    ...(breakdown.tools == null ? [] : [{ key: 'tools', label: $t('chat.context.toolsLabel'), value: breakdown.tools }]),
    ...(breakdown.overhead ? [{ key: 'overhead', label: $t('chat.context.overheadLabel'), value: breakdown.overhead }] : []),
    ...(breakdown.reserve ? [{ key: 'reserve', label: $t('chat.context.reserveLabel'), value: breakdown.reserve }] : [])
  ] : []);
  const chartWindow = $derived(Math.max(breakdown?.window ?? max, sections.reduce((sum, section) => sum + section.value, 0), 1));
</script>

<UiIconButton label={label} size="sm" bind:ref={anchor} type="button" class={uiClass(" context-ring", "ui-local-e4609396", {"has-label": showLabel})}
  aria-describedby={open ? id : undefined}
  onmouseenter={() => (open = true)} onmouseleave={() => (open = false)}
  onfocus={() => (open = true)} onblur={() => (open = false)} onclick={() => (open = true)}>
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle class="track" cx="7" cy="7" r="5.75" stroke-width="2.5"></circle>
    <circle class="progress" cx="7" cy="7" r="5.75" stroke-width="2.5"
      style:stroke={color} style:stroke-dasharray={circumference}
      style:stroke-dashoffset={circumference * (1 - percent / 100)}></circle>
  </svg>
  {#if showLabel}<span class="context-usage-label">{estimated ? '~' : ''}{percentLabel}%</span>{/if}
</UiIconButton>
{#if open}
  <ComposerCard {anchor} {id} label={label} tooltip placement="top-end" onclose={() => (open = false)}>
    <div>{label}</div>
    {#if breakdown}
      <div class="context-breakdown">
        <div class="context-bar" aria-hidden="true">
          {#each sections as section (section.key)}
            <span class:system={section.key === 'system'} class:messages={section.key === 'messages'} class:results={section.key === 'results'} class:tools={section.key === 'tools'} class:overhead={section.key === 'overhead'} class:reserve={section.key === 'reserve'} style:width={`${section.value / chartWindow * 100}%`}></span>
          {/each}
        </div>
        {#each sections as section (section.key)}
          <div class="context-row"><span class="context-name"><i class:system={section.key === 'system'} class:messages={section.key === 'messages'} class:results={section.key === 'results'} class:tools={section.key === 'tools'} class:overhead={section.key === 'overhead'} class:reserve={section.key === 'reserve'}></i>{section.label}</span><span>~{count(section.value)}</span></div>
        {/each}
        <div class="breakdown-note">{$t(breakdown.window ? 'chat.context.runtimeNote' : 'chat.context.previewNote')}</div>
      </div>
    {:else}
      <div class="breakdown-note">{$t('chat.context.breakdownUnavailable')}</div>
    {/if}
    <div>{$t('chat.context.remaining', { values: { n: count(Math.max(0, remaining ?? max - used)) } })}</div>
    {#if reservedTokens > 0}<div>{$t('chat.context.reserved', { values: { n: count(reservedTokens) } })}</div>{/if}
    {#if promptCostPerMillionUsd != null}<div>{$t('chat.context.priceIn', { values: { price: price(promptCostPerMillionUsd) } })}</div>{/if}
    {#if completionCostPerMillionUsd != null}<div>{$t('chat.context.priceOut', { values: { price: price(completionCostPerMillionUsd) } })}</div>{/if}
    {#if spend}<ComposerStatus {spend} />{/if}
  </ComposerCard>
{/if}

<style>
  :global(.context-ring.ui-local-e4609396) { flex-shrink: 0; }
  :global(.context-ring.has-label.ui-local-e4609396) { width:auto;gap:0.375rem;padding-inline:0.25rem;border:0;box-shadow:none;background:transparent; }
  .context-usage-label { font-size:var(--text-xs);color:var(--muted-foreground);white-space:nowrap; }
  .breakdown-note { color: var(--muted-foreground); }
  .context-breakdown { width: 17rem; max-width: 75vw; margin-top: 0.625rem; }
  .context-bar { display:flex; height:0.375rem; overflow:hidden; border-radius:99px; background:var(--muted); margin-bottom:0.625rem; }
  .context-bar span { min-width:0; }
  .context-row { display:flex; justify-content:space-between; gap:1rem; padding:0.125rem 0; font-variant-numeric:tabular-nums; }
  .context-name { display:inline-flex; align-items:center; gap:0.5rem; }
  .context-name i { width:0.5rem; height:0.5rem; border-radius:0.125rem; flex:none; }
  .system { background:#7773c7; } .messages { background:#729ab8; } .results { background:#8ca987; }
  .tools { background:#c2a276; } .overhead { background:#b88d91; } .reserve { background:#999; opacity:.45; }
  .breakdown-note { margin-top:0.375rem; white-space:normal; }
  :global(.context-ring:focus-visible.ui-local-e4609396) { outline: 2px solid var(--ring); outline-offset: 2px; }
  .track { fill: none; stroke: color-mix(in srgb, var(--muted-foreground) 20%, transparent); }
  .progress { fill: none; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset 140ms ease, stroke 140ms ease; }
  @media (prefers-reduced-motion: reduce) { .progress { transition: none; } }
</style>
