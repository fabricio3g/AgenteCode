<svelte:options runes={true} />

<!--
  Starter prompts under the composer, shown only while a conversation is empty.

  Selecting one fills the composer and focuses it rather than sending, so a
  mis-tap costs nothing and the prompt can be edited before it goes anywhere.
  The Design dock lists its own starters, so the composer is told to skip these.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { CloudSun, Code, Lightbulb, PenLine, BarChart3 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    /** Focuses the composer textarea after the prompt is inserted. */
    onpick: () => void;
  }

  let { onpick }: Props = $props();

  const ICONS = {
    weather: CloudSun,
    code: Code,
    write: PenLine,
    analyze: BarChart3,
    brainstorm: Lightbulb
  } as const;

  /** The artifact list's muted hues: each starter's glyph carries its own. */
  const HUES: Record<string, number> = { weather: 230, code: 280, write: 40, analyze: 200, brainstorm: 85 };

  function pick(prompt: string) {
    appStore.composer = prompt;
    onpick();
  }
</script>

<div class="suggestions">
  {#each copy.emptyState.suggestions as suggestion (suggestion.id)}
    {@const Icon = ICONS[suggestion.id as keyof typeof ICONS]}
    <UiButton variant="plain" style={`--hue:${HUES[suggestion.id] ?? 250}`} type="button" class={uiClass("suggestion", "ui-local-c934f14f")}  onclick={() => pick(suggestion.prompt)}>
      <Icon class="suggestion-icon size-3.5 shrink-0" />
      {suggestion.label}
    </UiButton>
  {/each}
</div>

<style>
  /* The composer dock is pointer-events:none so the thread stays scrollable
     behind it; anything interactive inside has to opt back in. */
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    pointer-events: auto;
  }

  :global(.suggestion.ui-local-c934f14f) {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    min-height: 2rem;
    padding: 0.375rem 0.75rem;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    letter-spacing: -0.005em;
    transition:
      background-color var(--motion-instant) var(--motion-ease),
      color var(--motion-instant) var(--motion-ease),
      transform var(--motion-fast) var(--motion-ease);
  }

  :global(.suggestion.ui-local-c934f14f) :global(.suggestion-icon) { color: oklch(0.72 0.11 var(--hue)); }
  :global(html:not(.dark)) :global(.suggestion.ui-local-c934f14f) :global(.suggestion-icon) { color: oklch(0.5 0.12 var(--hue)); }

  /* No outline at rest: the glyph's hue is the only colour; hover tints the chip with it. */
  :global(.suggestion:hover.ui-local-c934f14f) {
    background: oklch(0.62 0.09 var(--hue) / 0.1);
    color: var(--foreground);
  }

  :global(.suggestion:active.ui-local-c934f14f) {
    transform: scale(0.97);
  }

  :global(.suggestion:focus-visible.ui-local-c934f14f) {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }

  @media (max-width: 640px) {
    .suggestions {
      /* Scroll rather than stacking into rows that push the composer up. */
      flex-wrap: nowrap;
      overflow-x: auto;
      justify-content: flex-start;
      scrollbar-width: none;
    }
    .suggestions::-webkit-scrollbar {
      display: none;
    }
    :global(.suggestion.ui-local-c934f14f) {
      flex: 0 0 auto;
    }
  }
</style>
