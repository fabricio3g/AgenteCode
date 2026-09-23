<svelte:options runes={true} />

<!--
  World gallery: reusable scenes kits.

  Picking a world opens scene setup (cast, persona, opening). The pencil edits
  the world itself.
-->

<script lang="ts">
  import { Globe2, Pencil, Plus, Search } from 'lucide-svelte';
  import type { RoleplayWorld } from '$lib/types/chat';
  import { worldsStore } from './worlds.svelte';

  interface Props {
    onpick: (world: RoleplayWorld) => void;
    onedit: (world: RoleplayWorld) => void;
    onnew: () => void;
  }

  let { onpick, onedit, onnew }: Props = $props();

  let query = $state('');

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return worldsStore.worlds;
    return worldsStore.worlds.filter((world) =>
      [world.name, world.tagline, world.overview]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  });

  function castCount(world: RoleplayWorld): number {
    return world.castIds?.length || 0;
  }

  function loreCount(world: RoleplayWorld): number {
    return world.book?.entries?.length || 0;
  }
</script>

<div class="gallery mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <div class="mb-4 flex items-center gap-2">
    <div class="search-field">
      <Search class="search-icon" />
      <input class="aui-input search-input w-full" bind:value={query} placeholder="Search worlds" aria-label="Search worlds" />
    </div>
    <button type="button" class="aui-btn aui-btn-primary shrink-0" onclick={onnew}>
      <Plus class="size-4" />
      <span>New world</span>
    </button>
  </div>

  {#if !worldsStore.worlds.length}
    <div class="py-14 text-center">
      <p class="text-[15px] font-medium text-foreground">No worlds yet</p>
      <p class="mt-1 text-[13px] text-muted-foreground">
        A world bundles a setting, a lorebook and a cast, so scenes start consistent.
      </p>
    </div>
  {:else if !filtered.length}
    <div class="py-14 text-center text-[13px] text-muted-foreground">No matches</div>
  {:else}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {#each filtered as world (world.id)}
        <div class="world-card group relative">
          <button type="button" class="card-hit flex w-full flex-col items-center gap-2 p-4 text-center" onclick={() => onpick(world)}>
            <div class="cover">
              {#if world.avatar}
                <img src={world.avatar} alt={world.name} />
              {:else}
                <Globe2 class="size-5" />
              {/if}
            </div>
            <div class="min-w-0">
              <div class="truncate text-[14px] font-medium text-foreground">{world.name}</div>
              {#if world.tagline}
                <div class="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{world.tagline}</div>
              {/if}
            </div>
            <div class="meta">
              <span>{castCount(world)} cast</span>
              {#if loreCount(world)}<span>·</span><span>{loreCount(world)} lore</span>{/if}
              {#if world.starters?.length}<span>·</span><span>{world.starters.length} openings</span>{/if}
            </div>
          </button>
          <button
            type="button"
            class="edit-btn aui-icon-button absolute right-2 top-2 size-7 opacity-0 transition group-hover:opacity-100"
            onclick={() => onedit(world)}
            aria-label="Edit world"
          >
            <Pencil class="size-3.5" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search-field {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    min-width: 0;
  }

  .search-field :global(.search-icon) {
    position: absolute;
    left: 0.75rem;
    top: 50%;
    z-index: 1;
    width: 1rem;
    height: 1rem;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  .search-input {
    padding-left: 2.5rem;
  }

  .world-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .world-card:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  .card-hit {
    cursor: pointer;
  }

  .cover {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    color: var(--text-muted);
  }

  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .edit-btn {
    background: var(--popover);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }
</style>
