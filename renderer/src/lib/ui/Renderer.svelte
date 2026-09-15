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
  :global(.ui-stack) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  :global(.ui-panel) {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: var(--radius-md);
    padding: 1rem;
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
  :global(.ui-callout) {
    border-radius: var(--radius-md);
    padding: 0.85rem 1rem;
    border: 1px solid var(--border);
    background: var(--surface-hover);
  }
  :global(.ui-callout-info) {
    border-color: var(--info-border);
  }
  :global(.ui-callout-success) {
    border-color: var(--success-border);
  }
  :global(.ui-callout-warning) {
    border-color: var(--warning-border);
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
    border-radius: var(--radius-full);
    background: var(--surface-hover);
    color: var(--text-secondary);
    font-size: 0.82rem;
    border: 1px solid var(--border);
  }
  :global(.ui-button) {
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    padding: 0.65rem 1rem;
    font: inherit;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.04);
    transition: transform 0.1s ease, opacity 0.12s ease, border-color 0.12s ease;
  }
  :global(.ui-button:hover) {
    opacity: 0.88;
    border-color: var(--text);
  }
  :global(.ui-button:active) {
    transform: scale(0.98);
  }
  :global(.ui-button-primary) {
    background: var(--primary);
    color: var(--primary-fg);
  }
  :global(.ui-button-secondary), :global(.ui-button-tertiary) {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  :global(.ui-button-secondary:hover), :global(.ui-button-tertiary:hover) {
    background: var(--surface-hover);
    border-color: var(--fg-tertiary);
  }
  :global(.dark .ui-button) {
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 2px rgba(0,0,0,0.2);
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
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    padding: 0.75rem 0.85rem;
    font: inherit;
    transition: border-color 0.15s ease;
  }
  :global(.ui-input:focus), :global(.ui-textarea:focus) {
    outline: none;
    border-color: var(--border-hover);
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
    background: var(--surface-hover);
    color: var(--text-secondary);
    border-radius: var(--radius-full);
    padding: 0.45rem 0.8rem;
    cursor: pointer;
    font: inherit;
    transition: all 0.12s ease;
  }
  :global(.ui-tab-trigger:hover) {
    background: var(--surface);
    color: var(--text);
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
    border-radius: var(--radius-full);
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
    background: var(--surface-hover);
    border-radius: var(--radius-md);
    padding: 0.85rem 1rem;
    cursor: pointer;
    font: inherit;
    transition: all 0.15s ease;
  }
  :global(.ui-list-item:hover) {
    background: var(--surface);
    border-color: var(--border-hover);
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
    :global(.ui-panel) {
      padding: 0.85rem;
    }
    :global(.ui-chart-row) {
      grid-template-columns: 1fr;
    }
  }
</style>
