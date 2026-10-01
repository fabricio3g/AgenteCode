<svelte:options runes={true} />

<!--
  One item on a roleplay shelf — a world, a character or a persona: its
  picture beside the name, a short line and one meta line. Clicking opens it;
  hover (or focus) shows edit and a "…" menu — Edit, Duplicate, Delete — that
  a right-click opens too.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Copy as CopyIcon, MoreHorizontal, Pencil, Trash2 } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    title: string;
    subtitle?: string;
    meta?: string[];
    tags?: string[];
    /** A small mark beside the name, e.g. "Default". */
    badge?: string;
    /** What the item is, for labels: "world", "character", "persona". */
    kind: string;
    cover: Snippet;
    onopen: () => void;
    onedit: () => void;
    onduplicate: () => void;
    ondelete: () => void;
  }

  let { title, subtitle = '', meta = [], tags = [], badge = '', kind, cover, onopen, onedit, onduplicate, ondelete }: Props = $props();

  let menuOpen = $state(false);
  let anchorPoint = $state<{ x: number; y: number } | null>(null);

  function openContextMenu(event: MouseEvent) {
    event.preventDefault();
    anchorPoint = { x: event.clientX, y: event.clientY };
    menuOpen = true;
  }
</script>

<div class="lib-card group" class:is-open={menuOpen} role="group" aria-label={title} oncontextmenu={openContextMenu}>
  <button type="button" class="card-hit" onclick={onopen}>
    <span class="cover">{@render cover()}</span>
    <span class="body">
      <span class="title-row">
        <span class="title">{title || 'Untitled'}</span>
        {#if badge}<span class="badge">{badge}</span>{/if}
      </span>
      {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
      {#if meta.length}<span class="meta">{meta.join(' · ')}</span>{/if}
      {#if tags.length}
        <span class="tags">{#each tags.slice(0, 3) as tag (tag)}<span class="tag">{tag}</span>{/each}</span>
      {/if}
    </span>
  </button>

  <div class="actions">
    <button type="button" class="ui-icon-button is-sm" onclick={onedit} aria-label={`Edit ${kind}`} title={`Edit ${kind}`}><Pencil /></button>
    <Menu bind:open={menuOpen} bind:anchorPoint placement="bottom-end" label={`${kind} options`}>
      {#snippet trigger(props)}
        <button type="button" class="ui-icon-button is-sm" aria-label={`${kind} options`} {...props}><MoreHorizontal /></button>
      {/snippet}
      <MenuItem icon={Pencil} label={`Edit ${kind}`} onselect={onedit} />
      <MenuItem icon={CopyIcon} label="Duplicate" onselect={onduplicate} />
      <MenuItem icon={Trash2} label={copy.actions.delete} danger onselect={ondelete} />
    </Menu>
  </div>
</div>

<style>
  .lib-card {
    position: relative;
    border-radius: 0.875rem;
    background: var(--muted);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      transform var(--motion-fast) var(--motion-ease),
      box-shadow var(--motion-fast) var(--motion-ease);
  }
  .lib-card:hover,
  .lib-card:focus-within,
  .lib-card.is-open {
    background: var(--surface-active);
  }
  .lib-card:hover {
    transform: translateY(-1px);
  }

  .card-hit {
    display: flex;
    width: 100%;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card-hit:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .cover {
    display: flex;
    width: 3rem;
    height: 3rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 0.75rem;
    background: var(--card);
    color: var(--muted-foreground);
    font-size: 1.125rem;
    font-weight: 600;
  }
  .cover :global(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .body {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.125rem;
    /* Room for the hover actions so the name never runs under them. */
    padding-right: 3.5rem;
  }
  .title-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .badge {
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: 10.5px;
    font-weight: 500;
  }
  .subtitle {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .meta {
    margin-top: 0.25rem;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.375rem;
  }
  .tag {
    padding: 0.0625rem 0.45rem;
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--muted-foreground);
    font-size: 10.5px;
  }

  .actions {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }
  .lib-card:hover .actions,
  .lib-card:focus-within .actions,
  .lib-card.is-open .actions {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .lib-card:hover {
      transform: none;
    }
  }
</style>
