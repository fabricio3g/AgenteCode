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
  import { t } from 'svelte-i18n';

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

<div class="ui-modal-backdrop" role="presentation" use:modalLayer={{ onclose }} transition:motionFade={{ duration: 150 }} onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="ui-modal-surface max-w-3xl" role="dialog" aria-modal="true" aria-label={$t('roleplay.settings.title')} tabindex="-1" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}>
    <div class="ui-modal-header"><div><div class="ui-modal-title">{$t('roleplay.settings.title')}</div><p class="text-xs text-muted-foreground">{$t('roleplay.settings.subtitle')}</p></div><button type="button" class="ui-icon-button" aria-label={$t('roleplay.settings.close')} onclick={onclose}><X /></button></div>
    <div class="ui-modal-body max-h-[65vh] space-y-5 overflow-y-auto">
      <RoleplaySettingsEditor value={settings} {inherited} onchange={(next) => (settings = next)} />
      <details>
        <summary class="cursor-pointer text-sm text-muted-foreground">{$t('roleplay.room.title')}</summary>
        <div class="space-y-4 pt-4">
          <label class="block space-y-1"><span class="text-xs text-muted-foreground">{$t('roleplay.room.location')}</span><input class="ui-input" bind:value={room.location} placeholder={$t('roleplay.room.locationPlaceholder')} /></label>
          <div class="flex flex-wrap gap-2" role="group" aria-label={$t('roleplay.room.present')}>
            {#each cast as card (card.id)}
              <button type="button" class="ui-btn ui-btn-ghost" aria-pressed={room.presentIds.includes(card.id)} onclick={() => { room.presentIds = room.presentIds.includes(card.id) ? room.presentIds.filter((id) => id !== card.id) : [...room.presentIds, card.id]; }}>{#if room.presentIds.includes(card.id)}<Check class="size-3.5" />{/if}{card.name}</button>
            {/each}
          </div>
          {#each ['facts', 'goals', 'relationships'] as key}
            <label class="block space-y-1"><span class="text-xs text-muted-foreground">{$t(`roleplay.room.${key}`)}</span><textarea class="ui-input min-h-20 resize-y" value={room[key as 'facts' | 'goals' | 'relationships'].join('\n')} oninput={(event) => { room[key as 'facts' | 'goals' | 'relationships'] = event.currentTarget.value.split('\n').filter((line) => line.trim()).slice(0, 24); }}></textarea></label>
          {/each}
          {#each room.npcs as npc (npc.id)}
            <div class="space-y-1"><label class="text-xs text-muted-foreground">{$t('roleplay.room.npc')} <input class="ui-input" bind:value={npc.name} /></label><textarea class="ui-input" aria-label={$t('roleplay.room.npcDescription', { values: { name: npc.name } })} bind:value={npc.description}></textarea><div class="flex gap-2"><button type="button" class="ui-btn ui-btn-ghost" onclick={() => (room.npcs = room.npcs.filter((entry) => entry.id !== npc.id))}>{$t('roleplay.room.removeNpc', { values: { name: npc.name } })}</button><button type="button" class="ui-btn ui-btn-ghost" onclick={async () => { await charactersStore.save(emptyCharacter({ name: npc.name, description: npc.description })); toastStore.info($t('roleplay.room.savedToLibrary', { values: { name: npc.name } })); }}>{$t('roleplay.room.saveToLibrary')}</button></div></div>
          {/each}
          <p class="text-xs text-muted-foreground">{$t('roleplay.room.hint')}</p>
        </div>
      </details>
    </div>
    <div class="ui-modal-footer"><button type="button" class="ui-btn ui-btn-ghost" onclick={onclose}>{$t('roleplay.settings.cancel')}</button><button type="button" class="ui-btn ui-btn-primary" disabled={appStore.currentChatGenerating} onclick={save}>{$t('roleplay.settings.save')}</button></div>
  </div>
</div>
