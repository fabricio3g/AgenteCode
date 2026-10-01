<svelte:options runes={true} />

<!--
  One stretch of the model's reasoning, where it happened in the run. While
  the model is still thinking it stays open and follows the newest lines;
  the moment it moves on (a tool call, the reply) it folds to "Thought" and
  a one-line preview, like the TUI's collapsed ◇ thoughts.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ChevronRight, Sparkles } from 'lucide-svelte';

  let { text, live = false }: { text: string; live?: boolean } = $props();

  let userToggled = $state(false);
  let open = $state(false);
  $effect(() => {
    if (!userToggled) open = live;
  });

  const preview = $derived(text.trim().split('\n').find((line) => line.trim())?.replace(/^[#>*\-\s]+/, '') ?? '');

  let body = $state<HTMLDivElement>();
  $effect(() => {
    void text;
    if (live && open) void tick().then(() => { if (body) body.scrollTop = body.scrollHeight; });
  });

  function toggle() {
    userToggled = true;
    open = !open;
  }
</script>

<div class="thought">
  <button type="button" class="thought-head" aria-expanded={open} onclick={toggle}>
    <Sparkles class="size-3.5 shrink-0" />
    <span class="shrink-0 {live ? 'ui-legacy-shimmer-text' : 'text-foreground'}">{live ? $t('code.thinking') : $t('code.thought')}</span>
    {#if !open && preview}<span class="min-w-0 flex-1 truncate">{preview}</span>{:else}<span class="flex-1"></span>{/if}
    <ChevronRight class="chevron size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />
  </button>
  {#if open}
    <div bind:this={body} class="thought-body" class:is-live={live}>{text.trim()}</div>
  {/if}
</div>

<style>
  .thought-head {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: 12.5px;
    color: var(--muted-foreground);
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .thought-head:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .thought-head :global(.chevron) {
    opacity: 0;
    transition: transform var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }
  .thought-head:hover :global(.chevron),
  .thought-head:focus-visible :global(.chevron),
  .thought-head[aria-expanded='true'] :global(.chevron) {
    opacity: 1;
  }
  .thought-body {
    max-height: 16rem;
    overflow-y: auto;
    margin: 0.125rem 0 0.375rem 1.125rem;
    padding: 0.125rem 0.5rem 0.125rem 0.75rem;
    border-left: 1px solid var(--border-subtle);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--muted-foreground);
  }
  /* Live: a short window on the newest lines, fading out at the top. */
  .thought-body.is-live {
    max-height: 7.5rem;
    mask-image: linear-gradient(to bottom, transparent, #000 1.5rem);
  }
</style>
