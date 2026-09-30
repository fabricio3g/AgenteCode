<svelte:options runes={true} />
<script lang="ts">
  import { untrack } from 'svelte';
  import { Check, X } from 'lucide-svelte';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { charactersStore, emptyCharacter } from './characters.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import { worldsStore } from './worlds.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayPreferences } from './roleplay-presets.svelte';
  import { resolveRoleplaySettings } from './roleplay-settings';
  import RoleplaySettingsEditor from './RoleplaySettingsEditor.svelte';

  let { onclose }: { onclose: () => void } = $props();
  let settings = $state(untrack(() => ({ ...appStore.currentChat?.roleplay })));
  let room = $state(untrack(() => roleplayStore.room()));
  const cast = $derived((settings.characterIds ?? [appStore.currentChat?.characterId ?? '']).map((id) => charactersStore.getById(id)).filter((card) => !!card));
  const inherited = $derived(resolveRoleplaySettings(roleplayPreferences.defaults, worldsStore.getById(appStore.currentChat?.worldId)?.settings));
  function save() {
    roleplayStore.setSettings(settings);
    if (JSON.stringify(room) !== JSON.stringify(roleplayStore.room())) roleplayStore.setScene(room);
    onclose();
  }
</script>

<div class="aui-modal-backdrop" role="presentation" use:modalLayer={{ onclose }} transition:motionFade={{ duration: 150 }} onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="aui-modal-surface max-w-3xl" role="dialog" aria-modal="true" aria-label="Roleplay settings" tabindex="-1" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}>
    <div class="aui-modal-header"><div><div class="aui-modal-title">Roleplay settings</div><p class="text-xs text-muted-foreground">Shape this conversation. Both modes use your typed turns.</p></div><button type="button" class="aui-icon-button size-8" aria-label="Close settings" onclick={onclose}><X class="size-4" /></button></div>
    <div class="aui-modal-body max-h-[65vh] space-y-5 overflow-y-auto">
      <RoleplaySettingsEditor value={settings} {inherited} onchange={(next) => (settings = next)} />
      <details>
        <summary class="cursor-pointer text-sm text-muted-foreground">Room and editable memory</summary>
        <div class="space-y-4 pt-4">
          <label class="block space-y-1"><span class="text-xs text-muted-foreground">Location</span><input class="aui-input" bind:value={room.location} placeholder="Where this conversation takes place" /></label>
          <div class="flex flex-wrap gap-2" role="group" aria-label="Characters present">
            {#each cast as card (card.id)}
              <button type="button" class="aui-btn aui-btn-ghost" aria-pressed={room.presentIds.includes(card.id)} onclick={() => { room.presentIds = room.presentIds.includes(card.id) ? room.presentIds.filter((id) => id !== card.id) : [...room.presentIds, card.id]; }}>{#if room.presentIds.includes(card.id)}<Check class="size-3.5" />{/if}{card.name}</button>
            {/each}
          </div>
          {#each ['facts', 'goals', 'relationships'] as key}
            <label class="block space-y-1"><span class="text-xs text-muted-foreground">{key[0].toUpperCase() + key.slice(1)} · one per line</span><textarea class="aui-input min-h-20 resize-y" value={room[key as 'facts' | 'goals' | 'relationships'].join('\n')} oninput={(event) => { room[key as 'facts' | 'goals' | 'relationships'] = event.currentTarget.value.split('\n').filter((line) => line.trim()).slice(0, 24); }}></textarea></label>
          {/each}
          {#each room.npcs as npc (npc.id)}
            <div class="space-y-1"><label class="text-xs text-muted-foreground">Scene NPC <input class="aui-input" bind:value={npc.name} /></label><textarea class="aui-input" aria-label={`${npc.name} description`} bind:value={npc.description}></textarea><div class="flex gap-2"><button type="button" class="aui-btn aui-btn-ghost" onclick={() => (room.npcs = room.npcs.filter((entry) => entry.id !== npc.id))}>Remove {npc.name}</button><button type="button" class="aui-btn aui-btn-ghost" onclick={async () => { await charactersStore.save(emptyCharacter({ name: npc.name, description: npc.description })); toastStore.info(`${npc.name} saved to the character library.`); }}>Save to library</button></div></div>
          {/each}
          <p class="text-xs text-muted-foreground">Automatic memory comes from completed response versions. Pinned journal entries are also recalled. Manual room changes apply from this point forward.</p>
        </div>
      </details>
    </div>
    <div class="aui-modal-footer"><button type="button" class="aui-btn aui-btn-ghost" onclick={onclose}>Cancel</button><button type="button" class="aui-btn aui-btn-primary" disabled={appStore.currentChatGenerating} onclick={save}>Save</button></div>
  </div>
</div>
