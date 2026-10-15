<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { createUIContext } from './context';
  import RenderNode from './RenderNode.svelte';
  import { createParser } from './parser';
  import type { ActionEvent, ParseResult } from './types';
  import type { Library } from './library';

  interface Props {
    response: string | null;
    library: Library;
    isStreaming?: boolean;
    onAction?: (event: ActionEvent) => void;
    onStateUpdate?: (state: Record<string, any>) => void;
    initialState?: Record<string, any>;
    onParseResult?: (result: ParseResult | null) => void;
  }

  let {
    response,
    library,
    isStreaming = false,
    onAction,
    onStateUpdate,
    initialState,
    onParseResult
  }: Props = $props();

  // Capture library once for context/parser schema; components stay dynamic via library registry.
  const parser = $derived(createParser(library.toJSONSchema() as any));
  const result = $derived(response ? parser.parse(response) : null);

  // createUIContext must run at init; use getters so callbacks always see current props.
  const context = createUIContext({
    library: untrack(() => library),
    isStreaming: false,
    onAction: (event) => onAction?.(event),
    onStateUpdate: (state) => onStateUpdate?.(state),
    initialState: untrack(() => initialState) || {},
    renderNode: (value: unknown) => value
  });

  $effect(() => {
    context.setStreaming(!!isStreaming);
  });

  $effect(() => {
    onParseResult?.(result);
  });
</script>

{#if result?.root}
  <div class="ui-root">
    <RenderNode value={result.root} />
  </div>
{/if}

<style>
  :global(.ui-root) {
    width: 100%;
  }

  :global(.ui-chat-card) {
    background: var(--surface);
  }
  :global(.ui-title) {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.3;
    color: var(--text);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  :global(.ui-title-sm) {
    margin: 0;
    font-size: 1rem;
    color: var(--text);
    font-weight: 650;
  }
  :global(.ui-copy) {
    margin: 0;
    color: var(--text);
    line-height: 1.7;
  }
  :global(.ui-muted) {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.92rem;
    line-height: 1.5;
  }
  /* A callout is a rail, not another box: it usually sits inside a panel already. */
  /* Collapsible sections are rows on a divider, not stacked boxes. */

  /* A panel inside a panel drops its frame; the outer one already draws the edge. */

  :global(.ui-choice input) {
    accent-color: var(--foreground);
  }

  :global(.ui-image-block img), :global(.ui-gallery-image) {
    width: 100%;
    display: block;
    border-radius: var(--radius-md);
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--surface-hover);
  }
  :global(.ui-image-block figcaption) {
    margin-top: 0.45rem;
  }
  :global(.ui-gallery) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
  }

  :global(.ui-tags), :global(.ui-buttons) {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: center;
  }
  :global(.ui-tag) {
    padding: 0.35rem 0.7rem;
    border-radius: var(--radius-full);
    background: var(--surface-hover);
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  :global(.ui-form), :global(.ui-artifact-field) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  :global(.ui-field-label) {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }

  :global(.ui-choice) {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text);
  }
  :global(.ui-switch) {
    justify-content: space-between;
  }

  :global(.ui-steps) {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  :global(.ui-step) {
    display: grid;
    grid-template-columns: 2rem 1fr;
    gap: 0.85rem;
  }
  :global(.ui-step-index) {
    width: 2rem;
    height: 2rem;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    background: var(--surface-hover);
    color: var(--text-secondary);
    font-weight: 600;
  }
  :global(.ui-step-title) {
    color: var(--text);
    font-weight: 650;
    margin-bottom: 0.35rem;
  }

  :global(.ui-list-block) {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  :global(.ui-list-item) {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    border: 0;
    border-top: 1px solid var(--border-subtle);
    background: transparent;
    border-radius: 0;
    padding: 0.6rem 0.25rem;
    cursor: pointer;
    font: inherit;
    transition: all var(--motion-fast) var(--motion-ease);
  }
  :global(.ui-list-item:first-child) {
    border-top: 0;
  }
  :global(.ui-list-item:hover) {
    background: var(--surface-hover);
  }
  :global(.ui-list-label) {
    color: var(--text);
    font-weight: 650;
  }
  :global(.ui-chart-row) {
    display: grid;
    grid-template-columns: minmax(5rem, 9rem) 1fr auto;
    gap: 0.75rem;
    align-items: center;
    color: var(--text);
    font-size: 0.9rem;
  }
  :global(.ui-chart-track) {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-height: 0.85rem;
  }
  :global(.ui-chart-bar) {
    height: 0.85rem;
    border-radius: var(--radius-full);
    background: var(--primary);
  }
  :global(.ui-debug) {
    white-space: pre-wrap;
    color: var(--text-secondary);
  }
  @media (max-width: 640px) {

    :global(.ui-chart-row) {
      grid-template-columns: 1fr;
    }
  }
</style>
