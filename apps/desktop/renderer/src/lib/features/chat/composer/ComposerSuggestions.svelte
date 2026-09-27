<svelte:options runes={true} />

<!--
  Starter prompts under the composer, shown only while a conversation is empty.

  Selecting one fills the composer and focuses it rather than sending, so a
  mis-tap costs nothing and the prompt can be edited before it goes anywhere.
-->

<script lang="ts">
  import { BarChart3, CloudSun, Code, Lightbulb, PenLine } from 'lucide-svelte';
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

  function pick(prompt: string) {
    appStore.composer = prompt;
    onpick();
  }
</script>

<div class="suggestions">
  {#each copy.emptyState.suggestions as suggestion (suggestion.id)}
    {@const Icon = ICONS[suggestion.id as keyof typeof ICONS]}
    <button type="button" class="suggestion" onclick={() => pick(suggestion.prompt)}>
      <Icon class="size-3.5 shrink-0" />
      {suggestion.label}
    </button>
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

  .suggestion {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    min-height: 2rem;
    padding: 0.375rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--foreground);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.005em;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      transform 150ms var(--motion-ease);
  }

  .suggestion:hover {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--muted);
  }

  .suggestion:active {
    transform: scale(0.97);
  }

  .suggestion:focus-visible {
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

    .suggestion {
      flex: 0 0 auto;
    }
  }
</style>
