<svelte:options runes={true} />

<!--
  World gallery: reusable scene kits. Picking a world opens scene setup (cast,
  persona, opening); edit, duplicate and delete live on each card.
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { Globe2, Plus } from 'lucide-svelte';
  import type { RoleplayWorld } from '$lib/types/chat';
  import { worldsStore } from './worlds.svelte';
  import { deleteWorld, duplicateWorld } from './library-actions.svelte';
  import LibraryCard from './LibraryCard.svelte';
  import LibraryEmpty from './LibraryEmpty.svelte';
  import LibraryToolbar from './LibraryToolbar.svelte';

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
      [world.name, world.tagline, world.overview].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle))
    );
  });

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  function meta(world: RoleplayWorld): string[] {
    const lore = world.book?.entries?.length || 0;
    const openings = world.starters?.length || 0;
    return [plural(world.castIds?.length || 0, 'character', 'characters'), lore ? `${lore} lore` : '', openings ? plural(openings, 'opening', 'openings') : ''].filter(Boolean);
  }
</script>

<div class="library-shelf mx-auto w-full px-6 pb-6" style="max-width: var(--thread-width);">
  <LibraryToolbar bind:query placeholder={worldsStore.worlds.length ? 'Search worlds' : ''}>
    <Button variant="outline" size="sm" type="button" onclick={onnew}><Plus /> New world</Button>
  </LibraryToolbar>

  {#if !worldsStore.worlds.length}
    <LibraryEmpty title="No worlds yet" hint="A world bundles a setting, a lorebook and a cast, so scenes start consistent." action="New world" onaction={onnew} />
  {:else if !filtered.length}
    <LibraryEmpty title="No matches" action="Clear search" onaction={() => (query = '')} />
  {:else}
    <div class="library-grid">
      {#each filtered as world (world.id)}
        <LibraryCard
          kind="world"
          title={world.name}
          subtitle={world.tagline || world.overview}
          meta={meta(world)}
          onopen={() => onpick(world)}
          onedit={() => onedit(world)}
          onduplicate={() => void duplicateWorld(world)}
          ondelete={() => deleteWorld(world)}
        >
          {#snippet cover()}
            {#if world.avatar}<img src={world.avatar} alt="" />{:else}<Globe2 class="size-5" />{/if}
          {/snippet}
        </LibraryCard>
      {/each}
    </div>
  {/if}
</div>
