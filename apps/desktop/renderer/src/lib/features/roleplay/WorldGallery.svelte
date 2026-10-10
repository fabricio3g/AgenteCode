<svelte:options runes={true} />

<!--
  World gallery: reusable scene kits. Picking a world opens scene setup (cast,
  persona, opening); edit, duplicate and delete live on each card.
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { Globe2, Plus } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { copy } from '$lib/copy';
  import type { RoleplayWorld } from '$lib/types/chat';
  import { worldsStore } from './worlds.svelte';
  import { roleplayStore } from './roleplay.svelte';
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

  /** "2 characters · 3 lore entries · 2 openings": every count names what it counts. */
  function meta(world: RoleplayWorld): string[] {
    const lore = world.book?.entries?.length || 0;
    const openings = world.starters?.length || 0;
    const cast = world.castIds?.length || 0;
    return [
      cast ? $t('roleplay.library.countCharacters', { values: { n: cast } }) : $t('roleplay.library.countNoCast'),
      lore ? $t('roleplay.library.countLore', { values: { n: lore } }) : '',
      openings ? $t('roleplay.library.countOpenings', { values: { n: openings } }) : ''
    ].filter(Boolean);
  }
</script>

<div class="library-shelf">
  <LibraryToolbar bind:query placeholder={worldsStore.worlds.length ? $t('roleplay.library.searchWorlds') : ''}>
    <Button variant="outline" type="button" onclick={onnew}><Plus /> {$t('roleplay.library.newWorld')}</Button>
  </LibraryToolbar>

  {#if !worldsStore.worlds.length}
    <LibraryEmpty title={$t('roleplay.library.noWorlds')} hint={$t('roleplay.library.noWorldsHint')} action={$t('roleplay.library.newWorld')} onaction={onnew} />
  {:else if !filtered.length}
    <LibraryEmpty title={copy.empty.noMatches} action={$t('roleplay.library.clearSearch')} onaction={() => (query = '')} />
  {:else}
    <div class="library-grid">
      {#each filtered as world (world.id)}
        <LibraryCard
          title={world.name}
          editLabel={$t('roleplay.library.editWorld')}
          optionsLabel={$t('roleplay.library.worldOptions')}
          subtitle={roleplayStore.previewText(world.tagline || world.overview || '', { seed: world.id })}
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
