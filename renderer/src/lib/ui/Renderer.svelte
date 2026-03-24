<svelte:options runes={true} />

<script lang="ts">
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

  const parser = $derived(createParser(library.toJSONSchema() as any));
  const result = $derived(response ? parser.parse(response) : null);
  const context = createUIContext({
    library,
    isStreaming,
    onAction,
    onStateUpdate,
    initialState,
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
  :global(.ui-stack) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  :global(.ui-panel) {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 1rem;
    padding: 1rem;
  }
  :global(.ui-chat-card) {
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  :global(.ui-title) {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.3;
    color: var(--text);
    font-weight: 700;
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
  :global(.ui-callout) {
    border-radius: 0.9rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--border);
    background: var(--surface-highlight);
  }
  :global(.ui-callout-info) {
    border-color: color-mix(in srgb, var(--work-accent) 35%, var(--border));
  }
  :global(.ui-callout-success) {
    border-color: color-mix(in srgb, var(--success) 35%, var(--border));
  }
  :global(.ui-callout-warning) {
    border-color: color-mix(in srgb, var(--warning) 35%, var(--border));
  }
  :global(.ui-callout-neutral) {
    border-color: var(--border);
  }
  :global(.ui-callout-title) {
    margin: 0 0 0.35rem;
    color: var(--text);
    font-weight: 650;
  }
  :global(.ui-image-block img), :global(.ui-gallery-image) {
    width: 100%;
    display: block;
    border-radius: 0.8rem;
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--surface-highlight);
  }
  :global(.ui-image-block figcaption) {
    margin-top: 0.45rem;
  }
  :global(.ui-gallery) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
  }
  :global(.ui-table-wrap) {
    overflow-x: auto;
  }
  :global(.ui-table) {
    width: 100%;
    border-collapse: collapse;
    min-width: 28rem;
  }
  :global(.ui-table th), :global(.ui-table td) {
    border-bottom: 1px solid var(--border);
    padding: 0.7rem 0.8rem;
    text-align: left;
    color: var(--text);
    font-size: 0.92rem;
  }
  :global(.ui-table th) {
    color: var(--text-secondary);
    font-weight: 650;
  }
  :global(.ui-tags), :global(.ui-buttons) {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: center;
  }
  :global(.ui-tag) {
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    background: var(--surface-highlight);
    color: var(--text-secondary);
    font-size: 0.82rem;
    border: 1px solid var(--border);
  }
  :global(.ui-button) {
    border: 0;
    border-radius: 0.8rem;
    padding: 0.7rem 1rem;
    font: inherit;
    cursor: pointer;
    transition: opacity 0.18s ease;
  }
  :global(.ui-button:hover) {
    opacity: 0.92;
  }
  :global(.ui-button-primary) {
    background: var(--primary);
    color: var(--primary-fg);
  }
  :global(.ui-button-secondary), :global(.ui-button-tertiary) {
    background: var(--surface-highlight);
    color: var(--text);
    border: 1px solid var(--border);
  }
  :global(.ui-form), :global(.ui-field) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  :global(.ui-field-label) {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }
  :global(.ui-input), :global(.ui-textarea) {
    width: 100%;
    border-radius: 0.8rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    padding: 0.75rem 0.85rem;
    font: inherit;
  }
  :global(.ui-range) {
    width: 100%;
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
  :global(.ui-tab-list) {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
  }
  :global(.ui-tab-trigger) {
    border: 1px solid var(--border);
    background: var(--surface-highlight);
    color: var(--text-secondary);
    border-radius: 999px;
    padding: 0.45rem 0.8rem;
    cursor: pointer;
    font: inherit;
  }
  :global(.ui-tab-trigger.active) {
    background: var(--primary);
    color: var(--primary-fg);
    border-color: transparent;
  }
  :global(.ui-summary) {
    cursor: pointer;
    color: var(--text);
    font-weight: 650;
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
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-fg);
    font-weight: 700;
  }
  :global(.ui-step-title) {
    color: var(--text);
    font-weight: 650;
    margin-bottom: 0.35rem;
  }
  :global(.ui-separator) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 0.2rem 0;
  }
  :global(.ui-list-block) {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  :global(.ui-list-item) {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    border: 1px solid var(--border);
    background: var(--surface-highlight);
    border-radius: 0.9rem;
    padding: 0.85rem 1rem;
    cursor: pointer;
    font: inherit;
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
    border-radius: 999px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--primary) 75%, white), var(--primary));
  }
  :global(.ui-debug) {
    white-space: pre-wrap;
    color: var(--text-secondary);
  }
  @media (max-width: 640px) {
    :global(.ui-panel) {
      padding: 0.85rem;
    }
    :global(.ui-chart-row) {
      grid-template-columns: 1fr;
    }
  }
</style>
