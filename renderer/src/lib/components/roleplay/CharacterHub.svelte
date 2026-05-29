<svelte:options runes={true} />

<script lang="ts">
  import { BookOpen, ImageOff, Link, Plus, Trash2, Upload, UserPlus, Users, X } from 'lucide-svelte';
  import { roleplayStore } from '$lib/stores/roleplay.svelte';
  import type { RoleplayCharacter, RoleplayLorebook, RoleplayLorebookEntry } from '$lib/types/roleplay';

  let activeTab = $state<'characters' | 'lorebooks'>('characters');
  let url = $state('');
  let imageUrl = $state('');
  let importError = $state('');
  let imageError = $state('');
  let selectedCharacterId = $state<string | null>(null);
  let selectedLorebookId = $state<string | null>(null);

  const selectedCharacter = $derived(
    roleplayStore.characters.find((character) => character.id === selectedCharacterId) || roleplayStore.characters[0] || null
  );
  const selectedLorebook = $derived(
    roleplayStore.lorebooks.find((book) => book.id === selectedLorebookId) || roleplayStore.lorebooks[0] || null
  );
  const activeCharacterIds = $derived(new Set(roleplayStore.currentChat?.activeCharacterIds || []));
  const attachedSceneLorebookIds = $derived(new Set(roleplayStore.currentChat?.lorebookIds || []));

  function entryId() {
    if (crypto?.randomUUID) return `rp-entry-${crypto.randomUUID()}`;
    return `rp-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function updateCharacter(partial: Partial<RoleplayCharacter>) {
    if (!selectedCharacter) return;
    roleplayStore.upsertCharacter({ ...selectedCharacter, ...partial });
  }

  function updateLorebook(partial: Partial<RoleplayLorebook>) {
    if (!selectedLorebook) return;
    roleplayStore.updateLorebook(selectedLorebook.id, partial);
  }

  function updateLorebookEntry(entryId: string, partial: Partial<RoleplayLorebookEntry>) {
    if (!selectedLorebook) return;
    updateLorebook({
      entries: selectedLorebook.entries.map((entry) => entry.id === entryId ? { ...entry, ...partial } : entry)
    });
  }

  function addLorebookEntry() {
    if (!selectedLorebook) return;
    updateLorebook({
      entries: [
        ...selectedLorebook.entries,
        { id: entryId(), keys: [], content: '', enabled: true }
      ]
    });
  }

  function deleteLorebookEntry(targetId: string) {
    if (!selectedLorebook) return;
    updateLorebook({ entries: selectedLorebook.entries.filter((entry) => entry.id !== targetId) });
  }

  function createCharacter() {
    const character = roleplayStore.createCharacter();
    selectedCharacterId = character.id;
    activeTab = 'characters';
    imageUrl = '';
    imageError = '';
  }

  function createLorebook() {
    roleplayStore.createLorebook();
    selectedLorebookId = roleplayStore.lorebooks[0]?.id || null;
    activeTab = 'lorebooks';
  }

  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importError = '';
    try {
      const character = await roleplayStore.importCharacterFile(file);
      selectedCharacterId = character.id;
      activeTab = 'characters';
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      input.value = '';
    }
  }

  async function importUrl() {
    const target = url.trim();
    if (!target) return;
    importError = '';
    try {
      const character = await roleplayStore.importCharacterUrl(target);
      selectedCharacterId = character.id;
      activeTab = 'characters';
      url = '';
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }
  }

  async function replaceImage(event: Event) {
    if (!selectedCharacter) return;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    imageError = '';
    try {
      await roleplayStore.updateCharacterImageFromFile(selectedCharacter.id, file);
    } catch (error) {
      imageError = error instanceof Error ? error.message : String(error);
    } finally {
      input.value = '';
    }
  }

  async function pasteImage(event: ClipboardEvent) {
    if (!selectedCharacter) return;
    imageError = '';
    try {
      await roleplayStore.updateCharacterImageFromClipboard(selectedCharacter.id, event.clipboardData);
    } catch (error) {
      imageError = error instanceof Error ? error.message : String(error);
    }
  }

  async function applyImageUrl() {
    if (!selectedCharacter) return;
    const target = imageUrl.trim();
    if (!target) return;
    imageError = '';
    await roleplayStore.updateCharacterImageFromUrl(selectedCharacter.id, target);
    imageUrl = '';
  }

  function tagsText(character: RoleplayCharacter) {
    return character.tags.join(', ');
  }

  function keysText(entry: RoleplayLorebookEntry) {
    return entry.keys.join(', ');
  }
</script>

<div class="fixed inset-0 z-[280] flex bg-overlay p-4">
  <section class="hub m-auto flex h-[min(840px,94vh)] w-[min(1080px,96vw)] flex-col overflow-hidden rounded-xl bg-[var(--surface)] shadow-2xl">
    <header class="hub-header flex items-center justify-between gap-4 px-4 py-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-[var(--text)]">Character Hub</h2>
        <p class="text-xs text-[var(--text-muted)]">Characters and lorebooks for roleplay scenes.</p>
      </div>
      <div class="flex items-center gap-2">
        <div class="tabs">
          <button class="tab-btn" class:is-active={activeTab === 'characters'} onclick={() => (activeTab = 'characters')}>
            <Users class="h-4 w-4" />
            Characters
          </button>
          <button class="tab-btn" class:is-active={activeTab === 'lorebooks'} onclick={() => (activeTab = 'lorebooks')}>
            <BookOpen class="h-4 w-4" />
            Lorebooks
          </button>
        </div>
        <button class="icon-btn" aria-label="Close Character Hub" onclick={() => (roleplayStore.libraryOpen = false)}>
          <X class="h-4 w-4" />
        </button>
      </div>
    </header>

    {#if activeTab === 'characters'}
      <div class="hub-body grid min-h-0 flex-1 grid-cols-[270px_minmax(0,1fr)]">
        <aside class="hub-side min-h-0 overflow-y-auto px-3 py-3">
          <button class="row-action mb-2 flex w-full items-center gap-2 px-3 py-2 text-sm" onclick={createCharacter}>
            <UserPlus class="h-4 w-4" />
            Create character
          </button>
          <label class="row-action mb-2 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <Upload class="h-4 w-4" />
            Import file
            <input class="hidden" type="file" accept=".json,.png,application/json,image/png" onchange={importFile} />
          </label>
          <div class="mb-3 flex gap-1">
            <input class="field min-w-0 flex-1" bind:value={url} placeholder="Card URL" />
            <button class="icon-btn solid" aria-label="Import URL" onclick={importUrl}>
              <Link class="h-4 w-4" />
            </button>
          </div>
          {#if importError}
            <p class="mb-2 text-xs text-[var(--error)]">{importError}</p>
          {/if}

          <div class="space-y-1">
            {#each roleplayStore.characters as character (character.id)}
              <div class="list-row flex items-center gap-2 px-2 py-2" class:is-active={selectedCharacter?.id === character.id}>
                <button class="character-row-btn min-w-0 flex flex-1 items-center gap-2 text-left" onclick={() => (selectedCharacterId = character.id)}>
                  {#if character.avatarDataUrl}
                    <img class="h-9 w-9 rounded-md object-cover" src={character.avatarDataUrl} alt="" />
                  {:else}
                    <span class="avatar flex h-9 w-9 items-center justify-center rounded-md text-xs">{character.name.slice(0, 1)}</span>
                  {/if}
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-[var(--text)]">{character.name}</span>
                    <span class="block truncate text-xs text-[var(--text-muted)]">Character profile</span>
                  </span>
                </button>
                <button class="selector-btn text-xs" class:is-selected={activeCharacterIds.has(character.id)} onclick={() => roleplayStore.toggleCharacter(character.id)}>
                  {activeCharacterIds.has(character.id) ? 'In scene' : 'Add'}
                </button>
              </div>
            {/each}
          </div>
        </aside>

        <main class="min-h-0 overflow-y-auto px-5 py-4">
          {#if selectedCharacter}
            <div class="mb-5 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-base font-semibold text-[var(--text)]">{selectedCharacter.name}</h3>
                <p class="text-xs text-[var(--text-muted)]">Character profile and scene assignment.</p>
              </div>
              <button class="danger-btn flex items-center gap-2 px-3 py-2 text-sm" onclick={() => roleplayStore.deleteCharacter(selectedCharacter.id)}>
                <Trash2 class="h-4 w-4" />
                Delete
              </button>
            </div>

            <div class="avatar-editor mb-5 grid gap-3" onpaste={pasteImage}>
              <div class="flex gap-3">
                {#if selectedCharacter.avatarDataUrl}
                  <img class="avatar-preview" src={selectedCharacter.avatarDataUrl} alt={`${selectedCharacter.name} avatar`} />
                {:else}
                  <span class="avatar-preview avatar flex items-center justify-center text-2xl">{selectedCharacter.name.slice(0, 1)}</span>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-semibold text-[var(--text)]">Avatar</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">Paste an image here, choose a file, or use an image URL.</p>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <label class="row-action flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                      <Upload class="h-4 w-4" />
                      Replace image
                      <input class="hidden" type="file" accept="image/*" onchange={replaceImage} />
                    </label>
                    <button class="danger-btn flex items-center gap-2 px-3 py-2 text-sm" onclick={() => roleplayStore.removeCharacterImage(selectedCharacter.id)}>
                      <ImageOff class="h-4 w-4" />
                      Remove image
                    </button>
                  </div>
                </div>
              </div>
              <div class="flex gap-1">
                <input class="field min-w-0 flex-1" bind:value={imageUrl} placeholder="Image URL" />
                <button class="icon-btn solid" aria-label="Use image URL" onclick={applyImageUrl}>
                  <Link class="h-4 w-4" />
                </button>
              </div>
              {#if imageError}
                <p class="text-xs text-[var(--error)]">{imageError}</p>
              {/if}
            </div>

            <div class="grid gap-3">
              <label class="label">Name<input class="field" value={selectedCharacter.name} oninput={(e) => updateCharacter({ name: e.currentTarget.value })} /></label>
              <label class="label">Description<textarea class="field area" value={selectedCharacter.description} oninput={(e) => updateCharacter({ description: e.currentTarget.value })}></textarea></label>
              <label class="label">Personality<textarea class="field area" value={selectedCharacter.personality} oninput={(e) => updateCharacter({ personality: e.currentTarget.value })}></textarea></label>
              <label class="label">Scenario<textarea class="field area" value={selectedCharacter.scenario} oninput={(e) => updateCharacter({ scenario: e.currentTarget.value })}></textarea></label>
              <details>
                <summary class="text-sm font-medium text-[var(--text)]">Advanced fields</summary>
                <div class="mt-2 grid gap-3">
                  <label class="label">First Message<textarea class="field area" value={selectedCharacter.firstMessage} oninput={(e) => updateCharacter({ firstMessage: e.currentTarget.value })}></textarea></label>
                  <label class="label">Example Dialogue<textarea class="field area tall" value={selectedCharacter.exampleDialogue} oninput={(e) => updateCharacter({ exampleDialogue: e.currentTarget.value })}></textarea></label>
                  <label class="label">Tags<input class="field" value={tagsText(selectedCharacter)} oninput={(e) => updateCharacter({ tags: e.currentTarget.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} /></label>
                  <label class="label">Notes<textarea class="field area" value={selectedCharacter.creatorNotes} oninput={(e) => updateCharacter({ creatorNotes: e.currentTarget.value })}></textarea></label>
                </div>
              </details>
            </div>

          {:else}
            <div class="empty flex h-full items-center justify-center text-sm text-[var(--text-muted)]">Create or import a character to start.</div>
          {/if}
        </main>
      </div>
    {:else}
      <div class="hub-body grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
        <aside class="hub-side min-h-0 overflow-y-auto px-3 py-3">
          <button class="row-action mb-3 flex w-full items-center gap-2 px-3 py-2 text-sm" onclick={createLorebook}>
            <Plus class="h-4 w-4" />
            Create lorebook
          </button>
          <div class="space-y-1">
            {#each roleplayStore.lorebooks as book (book.id)}
              <button class="list-row block w-full px-3 py-2 text-left" class:is-active={selectedLorebook?.id === book.id} onclick={() => (selectedLorebookId = book.id)}>
                <span class="block truncate text-sm text-[var(--text)]">{book.name}</span>
                <span class="text-xs text-[var(--text-muted)]">{book.entries.length} entries</span>
              </button>
            {/each}
          </div>
        </aside>

        <main class="min-h-0 overflow-y-auto px-5 py-4">
          {#if selectedLorebook}
            <div class="mb-5 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-base font-semibold text-[var(--text)]">{selectedLorebook.name}</h3>
                <p class="text-xs text-[var(--text-muted)]">World info activated by keys and scene attachment.</p>
              </div>
              {#if !selectedLorebook.sourceCharacterId}
                <button class="danger-btn flex items-center gap-2 px-3 py-2 text-sm" onclick={() => roleplayStore.deleteLorebook(selectedLorebook.id)}>
                  <Trash2 class="h-4 w-4" />
                  Delete
                </button>
              {/if}
            </div>

            <div class="grid gap-3">
              <label class="label">Name<input class="field" value={selectedLorebook.name} oninput={(e) => updateLorebook({ name: e.currentTarget.value })} /></label>
              <div class="attachment-grid">
                <button class="attach-row" class:is-active={attachedSceneLorebookIds.has(selectedLorebook.id)} onclick={() => roleplayStore.toggleLorebook(selectedLorebook.id)}>
                  <span>
                    <span class="block text-sm font-semibold text-[var(--text)]">Current scene</span>
                    <span class="text-xs text-[var(--text-muted)]">Use this lorebook for the selected scene.</span>
                  </span>
                  <span class="text-xs font-semibold">{attachedSceneLorebookIds.has(selectedLorebook.id) ? 'Attached' : 'Attach'}</span>
                </button>
              </div>
            </div>

            <section class="mt-6">
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold text-[var(--text)]">Entries</p>
                  <p class="text-xs text-[var(--text-muted)]">Keys activate entries when they appear in recent chat context. Constant entries are always included.</p>
                </div>
                <button class="row-action flex items-center gap-2 px-3 py-2 text-sm" onclick={addLorebookEntry}>
                  <Plus class="h-4 w-4" />
                  Add entry
                </button>
              </div>
              <div class="entry-list">
                {#each selectedLorebook.entries as entry (entry.id)}
                  <div class="entry-row">
                    <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
                      <label class="label">Keys<input class="field" value={keysText(entry)} placeholder="tavern, storm" oninput={(e) => updateLorebookEntry(entry.id, { keys: e.currentTarget.value.split(',').map((key) => key.trim()).filter(Boolean) })} /></label>
                      <label class="label">Mode
                        <select class="field" value={entry.constant ? 'constant' : 'keyword'} onchange={(e) => updateLorebookEntry(entry.id, { constant: e.currentTarget.value === 'constant' })}>
                          <option value="keyword">Keyword</option>
                          <option value="constant">Always on</option>
                        </select>
                      </label>
                      <button class="icon-btn danger" aria-label="Delete entry" onclick={() => deleteLorebookEntry(entry.id)}>
                        <Trash2 class="h-4 w-4" />
                      </button>
                    </div>
                    <label class="label mt-2">Content<textarea class="field area" value={entry.content} oninput={(e) => updateLorebookEntry(entry.id, { content: e.currentTarget.value })}></textarea></label>
                    <label class="enabled-row mt-2">
                      <input type="checkbox" checked={entry.enabled} onchange={(e) => updateLorebookEntry(entry.id, { enabled: e.currentTarget.checked })} />
                      Enabled
                    </label>
                  </div>
                {/each}
                {#if !selectedLorebook.entries.length}
                  <p class="py-6 text-center text-sm text-[var(--text-muted)]">No entries yet. Add one to store scene facts, rules, memories, or world details.</p>
                {/if}
              </div>
            </section>
          {:else}
            <div class="empty flex h-full items-center justify-center text-sm text-[var(--text-muted)]">Create a lorebook to add world info.</div>
          {/if}
        </main>
      </div>
    {/if}
  </section>
</div>

<style>
  .hub {
    max-height: 94vh;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  }
  .hub-header {
    background: color-mix(in srgb, var(--surface-hover) 24%, var(--surface));
  }
  .hub-side {
    background: color-mix(in srgb, var(--surface-hover) 18%, var(--surface));
  }
  .tabs {
    display: inline-flex;
    gap: 0.25rem;
    border-radius: 999px;
    background: var(--surface);
    padding: 0.25rem;
  }
  .tab-btn, .icon-btn, .row-action, .danger-btn, .selector-btn {
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text);
  }
  .tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border-radius: 999px;
    padding: 0.4rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .tab-btn.is-active {
    background: var(--surface-hover);
    color: var(--text);
  }
  .icon-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    align-items: center;
    justify-content: center;
  }
  .icon-btn:hover, .row-action:hover, .selector-btn:hover, .list-row:hover, .attach-row:hover, .tab-btn:hover {
    background: var(--surface-hover);
  }
  .icon-btn.solid {
    background: var(--surface-hover);
  }
  .icon-btn.danger, .danger-btn {
    color: var(--error);
  }
  .icon-btn.danger:hover, .danger-btn:hover {
    background: var(--error-bg);
  }
  .field {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    padding: 0.55rem 0.65rem;
    font-size: 0.875rem;
    outline: none;
  }
  .field:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .area {
    min-height: 88px;
    resize: vertical;
  }
  .area.tall {
    min-height: 140px;
  }
  .label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.75rem;
    font-weight: 650;
    color: var(--text-secondary);
  }
  .list-row {
    border-radius: 10px;
    color: var(--text);
    transition: background 0.15s ease;
  }
  .character-row-btn {
    border: none;
    box-shadow: none;
    background: transparent;
    padding: 0;
  }
  .list-row.is-active {
    background: var(--surface-hover);
  }
  .selector-btn {
    min-width: 68px;
    padding: 0.3rem 0.65rem;
    color: var(--text-secondary);
    font-weight: 650;
  }
  .selector-btn.is-selected {
    background: var(--accent-soft);
    color: var(--text);
  }
  .avatar {
    background: var(--surface-hover);
    color: var(--text);
  }
  .avatar-preview {
    width: 104px;
    height: 104px;
    flex: 0 0 auto;
    border-radius: 10px;
    object-fit: cover;
    background: var(--surface-hover);
    color: var(--text);
  }
  .attachment-list, .entry-list {
    display: grid;
    gap: 0.35rem;
  }
  .attachment-grid {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .attach-row {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.7rem 0.8rem;
    text-align: left;
  }
  .attach-row.is-active {
    background: var(--surface-hover);
    color: var(--text);
  }
  .entry-row {
    border-radius: 12px;
    background: color-mix(in srgb, var(--surface-hover) 26%, transparent);
    padding: 0.8rem;
  }
  .enabled-row {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }
  @media (max-width: 840px) {
    .hub-body {
      grid-template-columns: 1fr;
    }
    .hub-side {
      max-height: 220px;
    }
    .attachment-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
