<svelte:options runes={true} />

<!--
  The Roleplay space surface.

  Two states:
  - No scene bound yet → the library: worlds, characters and personas.
  - Scene bound → the shared Thread and Composer, with the cast/persona strip
    between them. The cast is identified by the avatar and name on each reply,
    not by a separate header. No activity drawer: the tool loop never runs here.
-->

<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { copy } from '$lib/copy';
  import type { CharacterCard, RoleplayWorld, UserPersona } from '$lib/types/chat';
  import { charactersStore, emptyCharacter, greetingsFor } from './characters.svelte';
  import RoleplayLibrary from './RoleplayLibrary.svelte';
  import CharacterEditorModal from './CharacterEditorModal.svelte';
  import PersonaEditorModal from './PersonaEditorModal.svelte';
  import WorldEditorModal from './WorldEditorModal.svelte';
  import SceneSetupModal from './SceneSetupModal.svelte';
  import CastEditorModal from './CastEditorModal.svelte';
  import SceneJournal from './SceneJournal.svelte';
  import RoleplaySceneHeader from './RoleplaySceneHeader.svelte';
  import RoleplaySettingsModal from './RoleplaySettingsModal.svelte';
  import RoleplaySteerBar from './RoleplaySteerBar.svelte';
  import { t } from 'svelte-i18n';

  const currentChat = $derived(appStore.currentChat);
  const character = $derived(charactersStore.getById(currentChat?.characterId));
  const threadIsEmpty = $derived(!(currentChat?.messages?.length));
  const showLibrary = $derived(!character && threadIsEmpty);
  const cast = $derived.by(() => {
    const ids = currentChat?.roleplay?.characterIds?.length
      ? currentChat.roleplay.characterIds
      : currentChat?.characterId
        ? [currentChat.characterId]
        : [];
    return ids
      .map((id) => charactersStore.getById(id))
      .filter((card): card is CharacterCard => !!card);
  });
  const nextSpeaker = $derived(roleplayStore.peekSpeaker());
  const settings = $derived(roleplayStore.settings(currentChat));
  const room = $derived(roleplayStore.room(currentChat));
  const completion = $derived.by(() => {
    if (settings.autocomplete === 'off') return undefined;
    const candidates = [...cast.filter((card) => room.presentIds.includes(card.id)).map((card) => ({ ...card, description: card.tagline || card.nickname || card.id.slice(-8) })), ...room.npcs];
    return {
      candidates: candidates.map((candidate) => ({ ...candidate, disambiguate: candidates.some((other) => other.id !== candidate.id && other.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase()) })),
      automatic: settings.autocomplete === 'automatic', nickname: settings.nameInsertion === 'nickname'
    };
  });
  const persona = $derived(charactersStore.getPersonaById(currentChat?.personaId));
  const castNames = $derived(cast.map((card) => card.name).join(', '));

  /** A scene whose character or persona no longer resolves. */
  const missingCharacter = $derived(
    !!currentChat
      && currentChat.contextMode === 'roleplay'
      && !character
      && (threadIsEmpty === false || !!currentChat.characterId)
  );
  const missingPersona = $derived(
    !!currentChat?.personaId && !charactersStore.getPersonaById(currentChat.personaId)
  );

  let shelf = $state<'worlds' | 'characters' | 'personas'>('characters');
  let editorOpen = $state(false);
  let editing = $state<CharacterCard | null>(null);
  let personaEditorOpen = $state(false);
  let editingPersona = $state<UserPersona | null>(null);
  let worldEditorOpen = $state(false);
  let editingWorld = $state<RoleplayWorld | null>(null);
  let castEditorOpen = $state(false);
  let journalOpen = $state(false);
  let settingsOpen = $state(false);
  /** Scene setup target: a world, or null for a world-less quick scene. */
  let sceneSetup = $state<{ world: RoleplayWorld | null } | null>(null);

  function startWith(card: CharacterCard, greetingIndex: number) {
    roleplayStore.startSolo(card, {
      personaId: charactersStore.defaultPersona?.id ?? null,
      greetingIndex
    });
  }

  function pickCharacter(card: CharacterCard) {
    // The in-chat pager flips openings; no picker on the way in.
    startWith(card, 0);
  }

  function openNewCharacter() {
    editing = null;
    editorOpen = true;
  }

  function openEditCharacter(card: CharacterCard) {
    editing = card;
    editorOpen = true;
  }

  function openNewPersona() {
    editingPersona = null;
    personaEditorOpen = true;
  }

  function openEditPersona(persona: UserPersona) {
    editingPersona = persona;
    personaEditorOpen = true;
  }

  function openNewWorld() {
    editingWorld = null;
    worldEditorOpen = true;
  }

  function openEditWorld(world: RoleplayWorld) {
    editingWorld = world;
    worldEditorOpen = true;
  }

  function startScene(config: Parameters<typeof roleplayStore.startScene>[0]) {
    roleplayStore.startScene(config);
    sceneSetup = null;
  }

  function onPersona(personaId: string | null) {
    roleplayStore.setPersona(personaId);
  }

  function confirmDeleteScene() {
    confirmStore.show({
      ...copy.confirm.deleteChat,
      danger: true,
      onConfirm: () => {
        if (currentChat) appStore.deleteChat(currentChat.id);
      }
    });
  }
</script>

<div class="roleplay-panel relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  <div class="roleplay-content-layer relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if showLibrary}
      <RoleplayLibrary
        bind:shelf
        onpickCharacter={pickCharacter}
        oneditCharacter={openEditCharacter}
        onnewCharacter={openNewCharacter}
        onpickWorld={(world) => (sceneSetup = { world })}
        oneditWorld={openEditWorld}
        onnewWorld={openNewWorld}
        oneditPersona={openEditPersona}
        onnewPersona={openNewPersona}
        onnewScene={() => (sceneSetup = { world: null })}
      />
    {:else}
      <RoleplaySceneHeader
        mode={settings.interactionMode}
        onmode={(mode) => roleplayStore.setOption('interactionMode', mode)}
        onsettings={() => (settingsOpen = true)}
        presentIds={[...room.presentIds, ...room.npcs.map((npc) => npc.id)]}
        characters={[...cast, ...room.npcs.map((npc) => emptyCharacter({ id: npc.id, name: npc.name, description: npc.description }))]}
        personas={charactersStore.personas}
        activePersonaId={currentChat?.personaId ?? null}
        mutedIds={currentChat?.roleplay?.mutedIds ?? []}
        nextSpeakerId={nextSpeaker?.id ?? null}
        autoMode={settings.autoMode}
        disabled={appStore.currentChatGenerating}
        onpersona={onPersona}
        onpersonaedit={(persona) => {
          editingPersona = persona;
          personaEditorOpen = true;
        }}
        oncastedit={() => (castEditorOpen = true)}
        onspeak={(id) => void roleplayStore.speakNow(id)}
        onmute={(id) => roleplayStore.toggleMute(id)}
        onauto={(enabled) => roleplayStore.setAutoMode(enabled)}
        onjournal={() => (journalOpen = true)}
      />
      <Thread density={settings.messageDensity} />
      {#if threadIsEmpty && castNames}
        <div class="scene-hint">
          <span><span class="scene-hint-strong">{castNames}</span> {cast.length > 1 ? 'are' : 'is'} ready.</span>
          <span>Say something to begin{persona ? ` as ${persona.name}` : ''}.</span>
        </div>
      {/if}
      {#if missingCharacter || missingPersona}
        <div class="scene-banner">
          <AlertTriangle class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1">
            {missingCharacter
              ? "This scene's character is missing."
              : "This scene's persona is missing."}
          </span>
          {#if missingCharacter}
            <button type="button" class="aui-btn aui-btn-ghost" onclick={() => (castEditorOpen = true)}>
              Choose character
            </button>
            <button type="button" class="aui-btn aui-btn-ghost text-error" onclick={confirmDeleteScene}>
              Delete scene
            </button>
          {:else}
            <button type="button" class="aui-btn aui-btn-ghost" onclick={() => onPersona(null)}>
              Clear persona
            </button>
          {/if}
        </div>
      {/if}
      <Composer
        placeholder={settings.interactionMode !== 'chat' ? $t('roleplay.placeholder.scene') : $t('roleplay.placeholder.chat', { values: { name: character?.name || $t('roleplay.placeholder.room') } })}
        nameCompletion={completion}
      >
        {#snippet above()}<RoleplaySteerBar />{/snippet}
      </Composer>
    {/if}
  </div>
</div>

{#if editorOpen}
  <CharacterEditorModal
    character={editing}
    onclose={() => (editorOpen = false)}
    onsaved={() => (shelf = 'characters')}
  />
{/if}

{#if personaEditorOpen}
  <PersonaEditorModal
    persona={editingPersona}
    onclose={() => (personaEditorOpen = false)}
    onsaved={() => (shelf = 'personas')}
  />
{/if}

{#if worldEditorOpen}
  <WorldEditorModal
    world={editingWorld}
    onclose={() => (worldEditorOpen = false)}
    onsaved={() => (shelf = 'worlds')}
  />
{/if}

{#if castEditorOpen}
  <CastEditorModal
    characterIds={cast.map((card) => card.id)}
    onchange={(ids) => roleplayStore.setCast(ids)}
    onclose={() => (castEditorOpen = false)}
  />
{/if}

{#if journalOpen}
  <SceneJournal onclose={() => (journalOpen = false)} />
{/if}

{#if settingsOpen}
  <RoleplaySettingsModal onclose={() => (settingsOpen = false)} />
{/if}

{#if sceneSetup}
  <SceneSetupModal
    world={sceneSetup.world}
    onstart={startScene}
    onclose={() => (sceneSetup = null)}
  />
{/if}

<style>
  .roleplay-panel {
    background: var(--background);
    border: 0;
    border-radius: var(--radius-2xl) 0 0 0;
  }

  .scene-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0.35rem 0.35rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--text-muted);
    font-size: 0.75rem;
    pointer-events: auto;
  }

  .scene-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
    margin: auto auto 0.75rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-align: center;
  }

  .scene-hint-strong {
    color: var(--foreground);
    font-weight: 500;
  }
</style>
