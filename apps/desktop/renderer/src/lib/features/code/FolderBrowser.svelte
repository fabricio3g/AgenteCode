<svelte:options runes={true} />

<!--
  An in-app folder browser for picking a project, styled like a native file
  dialog: places on the left, a breadcrumb and an up button on top, the
  folders below (project roots first, marked). Click selects, double-click or
  → goes in, Enter opens the selection (or the current folder), Backspace goes
  up. "Browse…" falls back to the system dialog, and is all there is when the
  listing is unavailable (the browser preview).
-->

<script lang="ts">
  import UiToolbar from '$lib/components/ui/Toolbar.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowUp, ChevronRight, Folder, FolderGit2, House, LoaderCircle } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { browseFolders, type FolderListing } from '$lib/services/files';

  let { onopen, onsystem, embedded = false }: { onopen: (path: string) => void; onsystem: () => void; /** Inside a dialog: no card chrome of its own. */ embedded?: boolean } = $props();

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

  onMount(() => void go());

  /** The path as clickable segments, from the root down. */
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
  <div class="fallback"><Button onclick={onsystem}>{$t('code.browseSystem')}</Button></div>
{:else}
  <div class="browser" class:is-embedded={embedded} role="application" aria-label={$t('code.addProject')}>
    <nav class="places" aria-label={$t('code.browsePlaces')}>
      {#each listing?.places ?? [] as place (place.path)}
        <Button variant="plain" type="button" class={uiClass("place", "ui-local-2ec0e574", {"is-current": listing?.path === place.path})}  onclick={() => void go(place.path)}>
          {#if place.path === listing?.home}<House />{:else}<Folder />{/if}
          <span>{place.path === listing?.home ? place.name : place.name}</span>
        </Button>
      {/each}
    </nav>

    <div class="main">
      <UiToolbar wrap={false} class={uiClass("toolbar", "ui-local-2ec0e574")}>
        <UiIconButton label={$t('code.browseUp')} size="xs" type="button" class={uiClass(" ", "ui-local-2ec0e574")}  title={$t('code.browseUp')} disabled={!listing?.parent} onclick={() => listing?.parent && void go(listing.parent)}><ArrowUp /></UiIconButton>
        <div class="crumbs">
          {#each crumbs as crumb, index (crumb.path)}
            {#if index > 0}<ChevronRight class="crumb-sep" />{/if}
            <Button variant="plain" type="button" class={uiClass("crumb", "ui-local-2ec0e574", {"is-last": index === crumbs.length - 1})}  onclick={() => void go(crumb.path)}>{crumb.name}</Button>
          {/each}
        </div>
        {#if loading}<LoaderCircle class="spin" />{/if}
      </UiToolbar>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="list" bind:this={listEl} role="listbox" tabindex="0" aria-label={listing?.path} {onkeydown}>
        {#if failed}
          <p class="empty">{$t('code.browseUnreadable')}</p>
        {:else if listing && !listing.folders.length}
          <p class="empty">{$t('code.browseEmpty')}</p>
        {:else}
          {#each listing?.folders ?? [] as folder, index (folder.path)}
            <Button variant="plain"
              type="button"
              id="fb-{index}"
              class={uiClass("row", "ui-local-2ec0e574", {"is-selected": selected === folder.path})}
              
              role="option"
              aria-selected={selected === folder.path}
              tabindex={-1}
              onclick={() => (selected = folder.path)}
              ondblclick={() => void go(folder.path)}
            >
              {#if folder.isProject}<FolderGit2 class="row-icon is-project" />{:else}<Folder class="row-icon" />{/if}
              <span class="row-name">{folder.name}</span>
              {#if folder.isProject}<span class="row-tag">{$t('code.browseProject')}</span>{/if}
            </Button>
          {/each}
        {/if}
      </div>

      <div class="footer" title={$t('code.browseHint')}>
        <Button variant="ghost" size="sm" onclick={onsystem}>{$t('code.browseSystem')}</Button>
        <Button size="sm" disabled={!target} onclick={() => target && onopen(target)}>
          <span class="open-label">{$t('code.browseOpenNamed', { values: { name: targetName } })}</span>
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .browser {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    width: min(46rem, 100%);
    height: min(26rem, 60vh);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 0.75rem);
    background: var(--card);
    box-shadow: var(--float-shadow);
    text-align: left;
  }

  .browser.is-embedded { width: 100%; height: min(28rem, 62vh); border: 0; border-radius: 0; background: transparent; box-shadow: none; }

  .places {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    padding: 0.625rem 0.5rem;
    border-right: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--foreground) 2.5%, transparent);
  }
  :global(.place.ui-local-2ec0e574) {
    display: flex; align-items: center; gap: 0.5rem; min-width: 0;
    padding: 0.3125rem 0.5rem; border-radius: var(--float-row-radius);
    color: var(--text-secondary); font-size: var(--text-sm); text-align: left;
  }
  :global(.place.ui-local-2ec0e574) :global(svg) { width: 0.875rem; height: 0.875rem; flex-shrink: 0; color: var(--muted-foreground); }
  :global(.place.ui-local-2ec0e574) span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.place:hover.ui-local-2ec0e574) { background: var(--float-row-hover); color: var(--foreground); }
  :global(.place.is-current.ui-local-2ec0e574) { background: var(--float-row-selected); color: var(--foreground); }

  .main { display: flex; min-width: 0; min-height: 0; flex-direction: column; }

  :global(.toolbar.ui-local-2ec0e574) {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.625rem; border-bottom: 1px solid var(--border-subtle);
  }
  .crumbs { display: flex; min-width: 0; flex: 1; align-items: center; gap: 0.125rem; overflow: hidden; white-space: nowrap; }
  .crumbs :global(.crumb-sep) { width: 0.75rem; height: 0.75rem; flex-shrink: 0; color: var(--text-muted); }
  :global(.crumb.ui-local-2ec0e574) { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 0.125rem 0.3125rem; border-radius: 0.375rem; color: var(--muted-foreground); font-size: var(--text-sm); }
  :global(.crumb:hover.ui-local-2ec0e574) { background: var(--float-row-hover); color: var(--foreground); }
  :global(.crumb.is-last.ui-local-2ec0e574) { flex-shrink: 0; color: var(--foreground); font-weight: 500; }
  :global(.toolbar.ui-local-2ec0e574) :global(.spin) { width: 0.875rem; height: 0.875rem; color: var(--muted-foreground); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.375rem; outline: none; }
  .list:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--brand-accent) 45%, transparent); }
  .empty { padding: 0.75rem 0.625rem; color: var(--muted-foreground); font-size: var(--text-sm); }

  :global(.row.ui-local-2ec0e574) {
    display: flex; width: 100%; align-items: center; gap: 0.625rem;
    padding: 0.375rem 0.625rem; border-radius: var(--float-row-radius);
    color: var(--foreground); font-size: var(--text-sm); text-align: left; cursor: default;
  }
  :global(.row:hover.ui-local-2ec0e574) { background: var(--float-row-hover); }
  :global(.row.is-selected.ui-local-2ec0e574) { background: var(--float-row-selected); }
  :global(.row.ui-local-2ec0e574) :global(.row-icon) { width: 1rem; height: 1rem; flex-shrink: 0; color: var(--muted-foreground); }
  :global(.row.ui-local-2ec0e574) :global(.row-icon.is-project) { color: var(--brand-accent); }
  .row-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-tag { flex-shrink: 0; padding: 0 0.375rem; border-radius: var(--radius-full); background: var(--muted); color: var(--muted-foreground); font-size: var(--text-xs); }

  .footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem;
    padding: 0.5rem 0.625rem; border-top: 1px solid var(--border-subtle);
  }
  .open-label { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; }

  .fallback { display: flex; justify-content: center; padding: 1.5rem; }

  @media (max-width: 40rem) {
    .browser { grid-template-columns: minmax(0, 1fr); }
    .places { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { :global(.toolbar.ui-local-2ec0e574) :global(.spin) { animation: none; } }
</style>
