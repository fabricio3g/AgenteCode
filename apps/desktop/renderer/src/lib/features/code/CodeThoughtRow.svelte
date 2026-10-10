<svelte:options runes={true} />

<!--
  One stretch of the model's reasoning, where it happened in the run. While
  the model is still thinking it stays open and follows the newest lines;
  the moment it moves on (a tool call, the reply) it folds to "Thought" and
  a one-line preview, like the TUI's collapsed ◇ thoughts.

  This is the quietest level: no icon, no chevron of its own until it has more
  to say, and dimmer than everything around it.
-->

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import Disclosure from './Disclosure.svelte';

  let { text, id, live = false }: { text: string; id: string; live?: boolean } = $props();

  const preview = $derived(text.trimStart().slice(0, 240).split('\n', 1)[0].replace(/^[#>*\-\s]+/, ''));

  let textEl = $state<HTMLDivElement>();
  let scrollFrame = 0;
  let following = true;
  $effect(() => {
    void text;
    if (live && following && !scrollFrame) {
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (textEl && following) textEl.scrollTop = textEl.scrollHeight;
      });
    }
  });
  onDestroy(() => { if (scrollFrame) cancelAnimationFrame(scrollFrame); });
</script>

<Disclosure {id} level="thought" chevron="trailing" defaultOpen={false}>
  {#snippet header()}
    {#if live}<TileMeter mode="busy" />{/if}
    <span class="shrink-0">{live ? $t('code.thinking') : $t('code.thought')}</span>
    <span class="preview min-w-0 flex-1 truncate">{preview}</span>
  {/snippet}

  {#snippet body()}
    <div bind:this={textEl} class="thought-body" class:is-live={live} onscroll={() => { if (textEl) following = textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 24; }}>{text.trim()}</div>
  {/snippet}
</Disclosure>

<style>
  .preview {
    font-size: var(--text-xs);
  }
  .thought-body {
    max-height: 16rem;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--muted-foreground);
  }
  /* Live: a short window on the newest lines, fading out at the top. */
  .thought-body.is-live {
    max-height: 7.5rem;
    mask-image: linear-gradient(to bottom, transparent, #000 1.5rem);
  }
</style>
