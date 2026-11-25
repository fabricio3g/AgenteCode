<svelte:options runes={true} />

<!--
  Minimal in-app project folder picker: one flat surface, no inner boxes.
  Top line: Up + bare breadcrumb path on the left, quick places on the right.
  The pencil (or Ctrl+L, `/`, `~` in the list) turns the path into a field
  you can type or paste into; Enter goes there, Esc puts the crumbs back.
  Middle: flat folder rows with bare icons (project roots in accent).
  Bottom: Browse… on the left, Open <name> (or Use <name>) on the right.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowUp, ChevronRight, Folder, FolderGit2, FolderOpen, LoaderCircle, Pencil } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import { browseFolders, type FolderListing } from '$lib/services/files';

  let {
    onopen,
    onsystem,
    embedded = false,
    start,
    choose = false
  }: {
    onopen: (path: string) => void;
    onsystem: () => void;
    embedded?: boolean;
    /** The folder to open first (home when absent). */
    start?: string;
    /** Picking a parent folder rather than a project: the button says "Use". */
    choose?: boolean;
  } = $props();

  /** The path field, while it replaces the crumbs. */
  let editing = $state(false);
  let typed = $state('');
  let typedFailed = $state(false);
  let pathInput = $state<HTMLInputElement>();

  async function editPath(seed?: string) {
    typed = seed ?? listing?.path ?? '';
    typedFailed = false;
    editing = true;
    await tick();
    pathInput?.focus();
    if (seed === undefined) pathInput?.select();
  }

  async function goTyped() {
    const path = typed.trim();
    if (!path) return;
    try {
      const next = await browseFolders(path);
      listing = next;
      selected = null;
      failed = false;
      editing = false;
      await tick();
      listEl?.focus();
    } catch {
      typedFailed = true;
    }
  }

  let listing = $state<FolderListing | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let selected = $state<string | null>(null);
  let listEl = $state<HTMLDivElement>();

  async function go(path?: string) {
    loading = true;
    try {
      listing = await browseFolders(path);
      failed = false;
      selected = null;
      await tick();
      listEl?.scrollTo({ top: 0 });
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => void go(start));

  const crumbs = $derived.by(() => {
    if (!listing) return [];
    const { path, sep } = listing;
    const parts = path.split(sep).filter(Boolean);
    const rooted = path.startsWith(sep);
    return parts.map((name, index) => ({
      name,
      path: (rooted ? sep : '') + parts.slice(0, index + 1).join(sep) + (!rooted && index === 0 ? sep : '')
    }));
  });

  const target = $derived(selected ?? listing?.path ?? null);
  const targetName = $derived(target ? target.split(/[\\/]/).filter(Boolean).pop() ?? target : '');

  function onkeydown(event: KeyboardEvent) {
    if (!listing) return;
    if ((event.key === 'l' && (event.ctrlKey || event.metaKey)) || event.key === '/' || event.key === '~') {
      event.preventDefault();
      void editPath(event.key === '~' ? '~' : event.key === '/' ? '/' : undefined);
      return;
    }
    const folders = listing.folders;
    const index = folders.findIndex((folder) => folder.path === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, Math.min(folders.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      selected = folders[next]?.path ?? null;
      document.getElementById(`fb-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowRight' && selected) {
      event.preventDefault();
      void go(selected);
    } else if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && listing.parent) {
      event.preventDefault();
      void go(listing.parent);
    } else if (event.key === 'Enter' && target) {
      event.preventDefault();
      onopen(target);
    }
  }
</script>

{#if failed && !listing}
  <div class="fallback">
    <Button onclick={onsystem}>
      <FolderOpen class="size-4" />
      {$t('code.browseSystem')}
    </Button>
  </div>
{:else}
  <div class="browser" class:is-embedded={embedded} role="application" aria-label={$t('code.addProject')}>
    <div class="bar">
      <UiIconButton
        label={$t('code.browseUp')}
        size="xs"
        type="button"
        title={$t('code.browseUp')}
        disabled={!listing?.parent}
        onclick={() => listing?.parent && void go(listing.parent)}
      >
        <ArrowUp />
      </UiIconButton>

      {#if editing}
        <input
          bind:this={pathInput}
          bind:value={typed}
          class="path-input"
          class:is-invalid={typedFailed}
          spellcheck="false"
          autocomplete="off"
          aria-label={$t('code.browseTypePath')}
          aria-invalid={typedFailed}
          placeholder={$t('code.browseTypePathHint')}
          oninput={() => (typedFailed = false)}
          onkeydown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void goTyped(); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = false; listEl?.focus(); }
          }}
          onblur={() => { if (!typedFailed) editing = false; }}
        />
      {:else}
        <div class="crumbs" title={listing?.path}>
          {#each crumbs as crumb, index (crumb.path)}
            {#if index > 0}<span class="crumb-sep" aria-hidden="true">/</span>{/if}
            <button
              type="button"
              class="crumb"
              class:is-last={index === crumbs.length - 1}
              onclick={() => void go(crumb.path)}
            >
              {crumb.name}
            </button>
          {/each}
          <UiIconButton label={$t('code.browseTypePath')} size="xs" type="button" title={`${$t('code.browseTypePath')} (Ctrl+L)`} class="edit-path" onclick={() => void editPath()}>
            <Pencil />
          </UiIconButton>
        </div>
      {/if}

      {#if loading}
        <LoaderCircle class="spin" />
      {:else if listing?.places.length}
        <nav class="places" aria-label={$t('code.browsePlaces')}>
          {#each listing.places as place (place.path)}
            <button
              type="button"
              class="place"
              class:is-current={listing.path === place.path}
              onclick={() => void go(place.path)}
            >
              {place.name}
            </button>
          {/each}
        </nav>
      {/if}
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="list" bind:this={listEl} role="listbox" tabindex="0" aria-label={listing?.path} {onkeydown}>
      {#if failed}
        <p class="empty">{$t('code.browseUnreadable')}</p>
      {:else if listing && !listing.folders.length}
        <p class="empty">{$t('code.browseEmpty')}</p>
      {:else}
        {#each listing?.folders ?? [] as folder, index (folder.path)}
          {@const isSelected = selected === folder.path}
          <div
            id="fb-{index}"
            class="row"
            class:is-selected={isSelected}
            role="option"
            aria-selected={isSelected}
            tabindex={-1}
            onclick={() => (selected = folder.path)}
            ondblclick={() => void go(folder.path)}
            onkeydown={onkeydown}
          >
            {#if folder.isProject}
              <FolderGit2 class="row-icon is-project" />
            {:else}
              <Folder class="row-icon" />
            {/if}
            <span class="row-name">{folder.name}</span>
            {#if folder.isProject}
              <span class="row-tag">{$t('code.browseProject')}</span>
            {/if}
            <button
              type="button"
              class="row-enter"
              tabindex={-1}
              aria-label={`Open ${folder.name}`}
              onclick={(event) => {
                event.stopPropagation();
                void go(folder.path);
              }}
            >
              <ChevronRight class="size-3.5" />
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <div class="footer">
      <Button variant="ghost" size="sm" onclick={onsystem}>{$t('code.browseSystem')}</Button>
      <Button size="sm" disabled={!target} onclick={() => target && onopen(target)}>
        <span class="open-label">{$t(choose ? 'code.browseUseNamed' : 'code.browseOpenNamed', { values: { name: targetName } })}</span>
      </Button>
    </div>
  </div>
{/if}

<style>
  .browser {
    display: flex;
    flex-direction: column;
    width: min(40rem, 100%);
    height: min(26rem, 62vh);
    overflow: hidden;
    text-align: left;
  }

  .browser.is-embedded {
    width: 100%;
    height: min(27rem, 62vh);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem 0.5rem 0.75rem;
  }

  .crumbs {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.125rem;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
  }

  .path-input {
    min-width: 0;
    flex: 1;
    height: 1.625rem;
    padding: 0 0.5rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--float-row-hover);
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    outline: none;
  }

  .path-input:focus-visible {
    box-shadow: 0 0 0 1px var(--brand-accent);
  }

  .path-input.is-invalid {
    box-shadow: 0 0 0 1px var(--error);
  }

  .crumbs :global(.edit-path) {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity var(--motion-instant) var(--motion-ease);
  }

  .bar:hover .crumbs :global(.edit-path),
  .crumbs :global(.edit-path:focus-visible) {
    opacity: 0.85;
  }

  .crumb-sep {
    color: var(--text-tertiary);
    opacity: 0.5;
    font-size: var(--text-xs);
    user-select: none;
  }

  .crumb {
    flex-shrink: 0;
    padding: 0.125rem 0.3rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: color var(--motion-instant) var(--motion-ease),
      background-color var(--motion-instant) var(--motion-ease);
  }

  .crumb:hover {
    color: var(--foreground);
    background: var(--float-row-hover);
  }

  .crumb.is-last {
    color: var(--foreground);
    font-weight: 500;
  }

  .places {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .place {
    padding: 0.125rem 0.4rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: color var(--motion-instant) var(--motion-ease);
  }

  .place:hover {
    color: var(--foreground);
  }

  .place.is-current {
    color: var(--foreground);
    font-weight: 500;
  }

  .bar :global(.spin) {
    width: 0.875rem;
    height: 0.875rem;
    color: var(--muted-foreground);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    padding: 0.25rem 0.75rem 0.5rem;
    outline: none;
  }

  .empty {
    padding: 1.5rem 0.5rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    height: 2.125rem;
    padding: 0 0.5rem;
    border-radius: var(--float-row-radius);
    color: var(--foreground);
    font-size: var(--text-sm);
    cursor: pointer;
    user-select: none;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }

  .row:hover {
    background: var(--float-row-hover);
  }

  .row.is-selected {
    background: var(--float-row-selected);
  }

  .row :global(.row-icon) {
    width: 0.9375rem;
    height: 0.9375rem;
    flex-shrink: 0;
    color: var(--muted-foreground);
  }

  .row :global(.row-icon.is-project) {
    color: var(--brand-accent);
  }

  .row-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-tag {
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .row-enter {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    opacity: 0;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity var(--motion-instant) var(--motion-ease),
      color var(--motion-instant) var(--motion-ease);
  }

  .row:hover .row-enter,
  .row.is-selected .row-enter {
    opacity: 0.85;
  }

  .row-enter:hover {
    color: var(--foreground);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 1rem 0.75rem;
  }

  .open-label {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fallback {
    display: flex;
    justify-content: center;
    padding: 1.5rem;
  }

  @media (max-width: 36rem) {
    .places {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar :global(.spin) {
      animation: none;
    }
  }
</style>
