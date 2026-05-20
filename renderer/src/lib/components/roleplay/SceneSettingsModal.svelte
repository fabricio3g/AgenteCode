<svelte:options runes={true} />

<script lang="ts">
  import { BookOpen, PenLine, Users, X } from 'lucide-svelte';
  import LorebookSelectorModal from '$lib/components/roleplay/LorebookSelectorModal.svelte';
  import { roleplayStore } from '$lib/stores/roleplay.svelte';
  import type { RoleplayCharacter, RoleplayChat, RoleplayConversationMode, RoleplayLorebook } from '$lib/types/roleplay';

  let {
    chat,
    cast,
    lorebooks,
    onCast,
    onStart,
    onClose
  }: {
    chat: RoleplayChat;
    cast: RoleplayCharacter[];
    lorebooks: RoleplayLorebook[];
    onCast: () => void;
    onStart?: () => void;
    onClose: () => void;
  } = $props();

  let lorebookSelectorOpen = $state(false);

  const attachedLorebooks = $derived(lorebooks.filter((book) => chat.lorebookIds.includes(book.id)));

  const modes: { id: RoleplayConversationMode; label: string; hint: string }[] = [
    { id: 'oneToOne', label: '1 to 1', hint: 'One selected character speaks back.' },
    { id: 'group', label: 'Group Chat', hint: 'Cast members reply as a group chat.' },
    { id: 'narrative', label: 'Narrative', hint: 'More prose, action, and flexible dialogue.' }
  ];

  function setMode(mode: RoleplayConversationMode) {
    roleplayStore.updateSettings({ conversationMode: mode });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[255] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section class="scene-modal w-full max-w-3xl rounded-2xl bg-[var(--surface)] shadow-2xl" onclick={(event) => event.stopPropagation()}>
    <header class="flex items-start justify-between gap-4 px-5 py-4">
      <div class="min-w-0">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Create scene</p>
        <h2 class="text-lg font-semibold text-[var(--text)]">Start adventure</h2>
        <p class="mt-1 max-w-xl text-sm text-[var(--text-muted)]">Set the scenario, choose lorebooks, and decide how characters answer before the first turn.</p>
      </div>
      <button class="icon-btn" aria-label="Close scene settings" onclick={onClose}>
        <X class="h-4 w-4" />
      </button>
    </header>

    <div class="grid max-h-[72vh] gap-4 overflow-y-auto px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section class="grid gap-4">
        <div class="panel">
          <div class="mb-3 flex items-center gap-2">
            <span class="panel-icon"><PenLine class="h-4 w-4" /></span>
            <div>
              <p class="text-sm font-semibold text-[var(--text)]">Scenario</p>
              <p class="text-xs text-[var(--text-muted)]">Write your own setup, then optionally load lorebooks.</p>
            </div>
          </div>
          <textarea
            class="scenario-input"
            value={chat.settings.sceneContext}
            placeholder="Example: A quiet tavern after closing. Rain hits the windows. The party waits for someone carrying dangerous news."
            oninput={(event) => roleplayStore.updateSettings({ sceneContext: event.currentTarget.value })}
          ></textarea>
        </div>

        <div class="panel">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
              <span class="panel-icon"><BookOpen class="h-4 w-4" /></span>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-[var(--text)]">Lorebooks</p>
                <p class="truncate text-xs text-[var(--text-muted)]">
                  {attachedLorebooks.length ? attachedLorebooks.map((book) => book.name).join(', ') : 'No lorebooks loaded'}
                </p>
              </div>
            </div>
            <button class="ghost-btn px-3 py-2 text-sm" onclick={() => (lorebookSelectorOpen = true)}>Select</button>
          </div>
          {#if attachedLorebooks.length}
            <div class="selected-list">
              {#each attachedLorebooks as book (book.id)}
                <span class="selected-pill">{book.name}</span>
              {/each}
            </div>
          {:else}
            <p class="text-sm text-[var(--text-muted)]">Use lorebooks for world facts, memories, rules, locations, or recurring context.</p>
          {/if}
        </div>

        <div class="panel">
          <p class="mb-3 text-sm font-semibold text-[var(--text)]">Chat Mode</p>
          <div class="mode-grid">
            {#each modes as mode (mode.id)}
              <button class="mode-btn" class:is-active={chat.settings.conversationMode === mode.id} onclick={() => setMode(mode.id)}>
                <span class="block text-sm font-semibold">{mode.label}</span>
                <span class="mt-1 block text-xs text-[var(--text-muted)]">{mode.hint}</span>
              </button>
            {/each}
          </div>
          {#if cast.length && chat.settings.conversationMode === 'oneToOne'}
            <label class="label mt-3">
              Primary character
              <select class="field" value={chat.settings.primaryCharacterId || cast[0]?.id || ''} onchange={(event) => roleplayStore.updateSettings({ primaryCharacterId: event.currentTarget.value || null })}>
                {#each cast as character (character.id)}
                  <option value={character.id}>{character.name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      </section>

      <aside class="grid content-start gap-4">
        <div class="panel">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-[var(--text)]">Cast</p>
              <p class="truncate text-xs text-[var(--text-muted)]">{cast.length ? cast.map((character) => character.name).join(', ') : 'No characters selected'}</p>
            </div>
            <button class="ghost-btn px-3 py-2 text-sm" onclick={onCast}>Edit</button>
          </div>
          <div class="cast-strip">
            {#if cast.length}
              {#each cast.slice(0, 6) as character (character.id)}
                {#if character.avatarDataUrl}
                  <img class="cast-avatar" src={character.avatarDataUrl} alt={character.name} />
                {:else}
                  <span class="cast-avatar avatar">{character.name.slice(0, 1)}</span>
                {/if}
              {/each}
            {:else}
              <div class="empty-note flex items-center gap-2">
                <Users class="h-4 w-4" />
                Add characters for the scene.
              </div>
            {/if}
          </div>
        </div>

        <div class="panel">
          <label class="label">
            Speaker sections
            <input class="field" type="number" min="1" max="8" value={chat.settings.maxSpeakerTurns} oninput={(event) => roleplayStore.updateSettings({ maxSpeakerTurns: Number(event.currentTarget.value) })} />
          </label>
          <label class="toggle-row mt-3">
            <input type="checkbox" checked={chat.settings.allowNarrator} onchange={(event) => roleplayStore.updateSettings({ allowNarrator: event.currentTarget.checked })} />
            <span>
              <span class="block text-sm font-semibold text-[var(--text)]">Narrator</span>
              <span class="text-xs text-[var(--text-muted)]">Allow action and scene narration.</span>
            </span>
          </label>
        </div>
      </aside>
    </div>

    <footer class="flex items-center justify-end gap-2 px-5 pb-5">
      <button class="ghost-btn px-3 py-2 text-sm" onclick={onClose}>Cancel</button>
      <button class="primary-btn px-4 py-2 text-sm" onclick={() => {
        roleplayStore.updateSettings({ sceneSetupComplete: true });
        onStart?.();
      }}>{chat.settings.sceneSetupComplete ? 'Save scene' : 'Start scene'}</button>
    </footer>
  </section>
</div>

{#if lorebookSelectorOpen}
  <LorebookSelectorModal
    lorebooks={lorebooks}
    initialSelectedIds={chat.lorebookIds}
    onClose={() => (lorebookSelectorOpen = false)}
    onApply={(ids) => {
      roleplayStore.setAttachedLorebooks(ids);
      lorebookSelectorOpen = false;
    }}
  />
{/if}

<style>
  .scene-modal {
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  }
  .panel {
    border-radius: 16px;
    background: color-mix(in srgb, var(--surface-hover) 34%, transparent);
    padding: 0.9rem;
  }
  .panel-icon {
    display: inline-flex;
    height: 32px;
    width: 32px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-secondary);
  }
  .icon-btn, .ghost-btn {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text);
  }
  .icon-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    align-items: center;
    justify-content: center;
  }
  .icon-btn:hover, .ghost-btn:hover, .mode-btn:hover {
    background: var(--surface-hover);
  }
  .primary-btn {
    border: 1px solid #E20E0F;
    border-radius: 999px;
    background: #E20E0F;
    color: var(--primary-fg);
    font-weight: 700;
  }
  .scenario-input {
    min-height: 150px;
    width: 100%;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
    padding: 0.8rem;
    font-size: 0.9rem;
    line-height: 1.55;
    outline: none;
  }
  .scenario-input:focus, .field:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.75rem;
    font-weight: 650;
    color: var(--text-secondary);
  }
  .field {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    padding: 0.6rem 0.7rem;
    font-size: 0.875rem;
    outline: none;
  }
  .mode-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }
  .mode-btn {
    border: 1px solid transparent;
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    padding: 0.75rem;
    text-align: left;
  }
  .mode-btn.is-active {
    border-color: var(--border);
    background: var(--surface-hover);
  }
  .selected-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .selected-pill {
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 0.75rem;
    padding: 0.3rem 0.6rem;
  }
  .cast-strip {
    display: flex;
    min-height: 38px;
    align-items: center;
    gap: 0.35rem;
  }
  .cast-avatar {
    display: inline-flex;
    height: 34px;
    width: 34px;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    object-fit: cover;
    font-size: 0.8rem;
    font-weight: 700;
  }
  .empty-note {
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  @media (max-width: 720px) {
    .mode-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
