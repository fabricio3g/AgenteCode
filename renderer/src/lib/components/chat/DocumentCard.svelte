<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Download, ChevronDown, ChevronUp, AlertCircle } from 'lucide-svelte';
  import { getFileIcon, formatSize, type ViewerKind } from '$lib/utils/doc-utils';

  interface Props {
    name: string;
    type?: string;
    size?: number;
    viewerKind: ViewerKind;
    collapsed?: boolean;
    compact?: boolean;
    error?: string;
    hasData?: boolean;
    onToggle?: () => void;
    onDownload?: () => void;
    children?: Snippet;
  }

  let {
    name,
    type = '',
    size = 0,
    viewerKind,
    collapsed = true,
    compact = false,
    error = '',
    hasData = true,
    onToggle,
    onDownload,
    children
  }: Props = $props();

  const fileIcon = $derived(getFileIcon(name, type));
  const canToggle = $derived(viewerKind !== 'unknown' && viewerKind !== 'image' && !!onToggle);
  const canOpen = $derived(canToggle && hasData);
</script>

<div class="doc-viewer-wrap" class:compact>
  <div class="doc-viewer-header" class:compact>
    <button
      class="doc-open-area"
      type="button"
      onclick={() => onToggle?.()}
      disabled={!canOpen}
      title={collapsed ? `View ${name}` : `Hide ${name}`}
    >
      <div class="doc-icon-wrap">
        {#each [fileIcon] as Icon}
          <Icon class="h-4 w-4" />
        {/each}
      </div>
      <div class="doc-meta">
        <span class="doc-name">{name}</span>
        {#if size > 0}
          <span class="doc-size">{formatSize(size)}</span>
        {/if}
      </div>
    </button>
    <div class="doc-actions">
      {#if hasData && onDownload}
        <button class="doc-action-btn" onclick={onDownload} title="Download {name}">
          <Download class="h-3.5 w-3.5" />
        </button>
      {/if}
      {#if canToggle}
        <button class="doc-action-btn" onclick={() => onToggle?.()} title={collapsed ? 'View' : 'Collapse'}>
          {#if collapsed}
            <ChevronDown class="h-3.5 w-3.5" />
          {:else}
            <ChevronUp class="h-3.5 w-3.5" />
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="doc-error">
      <AlertCircle class="h-3.5 w-3.5" />
      <span>{error}</span>
    </div>
  {/if}

  {#if !collapsed}
    <div class="doc-viewer-body">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .doc-viewer-wrap {
    display: flex;
    flex-direction: column;
    margin-top: 0.75rem;
    overflow: hidden;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .doc-viewer-wrap.compact {
    margin-top: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .doc-viewer-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.2rem 0;
    font-size: 0.75rem;
  }

  .doc-viewer-header.compact {
    align-items: stretch;
    gap: 0.35rem;
    padding: 0;
  }

  .doc-open-area {
    all: unset;
    box-sizing: border-box;
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    cursor: pointer;
  }

  .doc-viewer-header.compact .doc-open-area {
    width: min(12rem, 100%);
    min-height: 2.35rem;
    border: 0;
    background: transparent;
  }

  .doc-open-area:hover:not(:disabled) {
    color: inherit;
  }

  .doc-open-area:disabled {
    cursor: default;
  }

  .doc-icon-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    background: transparent;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .doc-viewer-header.compact .doc-icon-wrap {
    width: 1.25rem;
    height: 1.25rem;
    background: transparent;
    color: var(--text-muted);
  }

  .doc-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .doc-name {
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .doc-size {
    font-size: 0.65rem;
    color: var(--text-muted);
    margin-top: 0.05rem;
  }

  .doc-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex-shrink: 0;
  }

  .doc-viewer-header.compact .doc-actions {
    align-self: center;
  }

  .doc-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-sm);
    padding: 0;
    color: var(--text-tertiary);
    transition: background 150ms ease, color 150ms ease;
  }

  .doc-action-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .doc-error {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.3rem;
    font-size: 0.6875rem;
    color: var(--error);
  }

  .doc-viewer-body {
    margin-top: 0.45rem;
    border-top: 1px solid var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-overlay);
    overflow: hidden;
  }

  .doc-viewer-header.compact + .doc-viewer-body,
  .doc-error + .doc-viewer-body {
    margin-top: 0.6rem;
  }
</style>
