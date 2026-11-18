<svelte:options runes={true} />

<!--
  How many subagents, and how many still working or failed: the words the pill
  over the composer and a turn's line in the transcript share, so the two say
  it the same way. A live meter leads while any child works.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Bot } from '$lib/icons';
  import type { CodeChild } from '$shared/agente-protocol';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';

  let { children, stopping = false }: { children: readonly CodeChild[]; stopping?: boolean } = $props();

  const working = $derived(children.filter((child) => child.status === 'running').length);
  const failed = $derived(children.filter((child) => child.status === 'error').length);
</script>

{#if working}<TileMeter mode={stopping ? 'stopped' : 'busy'} />{:else}<Bot class="size-3.5" />{/if}
<span>{$t('sessionHud.pill', { values: { n: children.length } })}</span>
{#if working}<span class="sep">·</span><span class="live">{$t('sessionHud.pillWorking', { values: { n: working } })}</span>{/if}
{#if failed}<span class="sep">·</span><span class="text-error">{$t('sessionHud.pillFailed', { values: { n: failed } })}</span>{/if}

<style>
  .live { color: var(--foreground); }
  .sep { opacity: 0.6; }
</style>
