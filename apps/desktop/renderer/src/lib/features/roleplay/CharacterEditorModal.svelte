<svelte:options runes={true} />

<!--
  Character editor.

  Field names follow the community Character Card V2/V3 spec so cards can be
  imported and exported without translation. Empty optional fields are stored
  as empty strings/arrays, never dropped.
-->

<script lang="ts">
  import { deleteCharacter } from './library-actions.svelte';
  import { untrack } from 'svelte';
  import { X, Plus, Trash2, Upload } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button } from '$lib/components/ui';
  import type { CharacterCard } from '$lib/types/chat';
  import { charactersStore, emptyCharacter } from './characters.svelte';
  import LorebookEditor from './LorebookEditor.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import VoiceAssignmentEditor from '$lib/components/settings/voice/VoiceAssignmentEditor.svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** null = create a new character. */
    character?: CharacterCard | null;
    onclose: () => void;
    onsaved?: (card: CharacterCard) => void;
  }

  let { character = null, onclose, onsaved }: Props = $props();

  // Snapshot once: the modal edits a local copy and only writes on Save.
  let draft = $state<CharacterCard>(untrack(() => (character ? { ...character } : emptyCharacter())));
  // Backdrop, Escape, X and Cancel all ask before throwing edits away.
  const guard = dirtyGuard(() => draft);
  let saving = $state(false);
  let section = $state<'basics' | 'prompt' | 'greetings' | 'lore' | 'voice' | 'advanced'>('basics');

  const isNew = $derived(!character);

  function set<K extends keyof CharacterCard>(key: K, value: CharacterCard[K]) {
    draft = { ...draft, [key]: value };
  }

  function tagsToText(tags: string[]): string {
    return tags.join(', ');
  }

  function updateTags(raw: string) {
    set('tags', raw.split(',').map((tag) => tag.trim()).filter(Boolean));
  }

  function updateGreeting(index: number, value: string) {
    const next = [...draft.alternateGreetings];
    next[index] = value;
    set('alternateGreetings', next);
  }

  function addGreeting() {
    set('alternateGreetings', [...draft.alternateGreetings, '']);
  }

  function removeGreeting(index: number) {
    set('alternateGreetings', draft.alternateGreetings.filter((_, i) => i !== index));
  }

  async function onAvatarPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toastStore.error('Avatar images must be under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('avatar', String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!draft.name.trim()) {
      toastStore.error('Give the character a name first.');
      section = 'basics';
      return;
    }
    saving = true;
    try {
      const saved = await charactersStore.save({ ...draft, name: draft.name.trim() });
      onsaved?.(saved);
      onclose();
    } finally {
      saving = false;
    }
  }

  const sections = $derived<Array<{ id: typeof section; label: string }>>(
    (['basics', 'prompt', 'greetings', 'lore', 'voice', 'advanced'] as const).map((id) => ({ id, label: $t(`roleplay.character.tab.${id}`) }))
  );
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: () => guard.close(onclose) }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) guard.close(onclose);
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-3xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{isNew ? 'New character' : draft.name || 'Edit character'}</div>
        <div class="text-xs text-muted-foreground">Character card fields follow the V2/V3 spec.</div>
      </div>
      <button type="button" class="ui-icon-button" onclick={() => guard.close(onclose)} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] px-5 py-2">
      {#each sections as item (item.id)}
        <button
          type="button"
          class="rounded-full px-3 py-1.5 text-[12px] font-medium transition {section === item.id
            ? 'bg-[var(--surface-active)] text-foreground'
            : 'text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground'}"
          onclick={() => (section = item.id)}
        >
          {item.label}
        </button>
      {/each}
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      {#if section === 'basics'}
        <div class="flex items-start gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="avatar-preview">
              {#if draft.avatar}
                <img src={draft.avatar} alt={draft.name || 'Character avatar'} />
              {:else}
                <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
              {/if}
            </div>
            <label class="avatar-upload">
              <Upload class="size-3.5" />
              <span>Upload</span>
              <input class="hidden" type="file" accept="image/*" onchange={onAvatarPicked} />
            </label>
          </div>

          <div class="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block space-y-1.5 text-sm sm:col-span-2">
              <span class="font-medium text-muted-foreground">Name</span>
              <input class="ui-input" bind:value={draft.name} placeholder="e.g. Aiko" />
            </label>
            <label class="block space-y-1.5 text-sm sm:col-span-2">
              <span class="font-medium text-muted-foreground">Nickname</span>
              <span class="block text-xs text-muted-foreground">How the cast may address them in group scenes.</span>
              <input
                class="ui-input"
                value={draft.nickname || ''}
                oninput={(e) => set('nickname', e.currentTarget.value)}
                placeholder="Optional"
              />
            </label>
            <label class="block space-y-1.5 text-sm sm:col-span-2">
              <span class="font-medium text-muted-foreground">Tagline</span>
              <input class="ui-input" bind:value={draft.tagline} placeholder="One line shown in the gallery" />
            </label>
            <label class="block space-y-1.5 text-sm sm:col-span-2"><span class="font-medium text-muted-foreground">Aliases</span><input class="ui-input" value={(draft.aliases ?? []).join(', ')} placeholder="Alternative names, separated by commas" oninput={(event) => set('aliases', event.currentTarget.value.split(',').map((name) => name.trim()).filter(Boolean))} /></label>
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">Tags</span>
              <input class="ui-input" value={tagsToText(draft.tags)} oninput={(e) => updateTags(e.currentTarget.value)} placeholder="fantasy, slice-of-life" />
            </label>
            <label class="block space-y-1.5 text-sm">
              <span class="font-medium text-muted-foreground">Creator</span>
              <input class="ui-input" bind:value={draft.creator} placeholder="Your name" />
            </label>
          </div>
        </div>
      {/if}

      {#if section === 'prompt'}
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Description</span>
          <span class="block text-xs text-muted-foreground">Background, appearance, facts. Always sent.</span>
          <textarea class="ui-input min-h-28 resize-y" bind:value={draft.description} placeholder="&#123;&#123;char&#125;&#125; is a 24-year-old barista…"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Personality</span>
          <span class="block text-xs text-muted-foreground">How the character behaves and speaks.</span>
          <textarea class="ui-input min-h-24 resize-y" bind:value={draft.personality} placeholder="Sarcastic but quietly protective…"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Scenario</span>
          <span class="block text-xs text-muted-foreground">The situation the scene starts in.</span>
          <textarea class="ui-input min-h-20 resize-y" bind:value={draft.scenario} placeholder="&#123;&#123;user&#125;&#125; is a regular customer…"></textarea>
        </label>
      {/if}

      {#if section === 'greetings'}
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">First message</span>
          <span class="block text-xs text-muted-foreground">The character's opening line in a new chat.</span>
          <textarea class="ui-input min-h-24 resize-y" bind:value={draft.firstMessage} placeholder="&quot;You again? We close in twenty minutes.&quot;"></textarea>
        </label>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-muted-foreground">Alternate greetings</span>
            <button type="button" class="ui-btn ui-btn-ghost" onclick={addGreeting}>
              <Plus class="size-3.5" /> Add
            </button>
          </div>
          {#each draft.alternateGreetings as greeting, index (index)}
            <div class="flex items-start gap-2">
              <textarea
                class="ui-input min-h-16 flex-1 resize-y"
                value={greeting}
                oninput={(e) => updateGreeting(index, e.currentTarget.value)}
                placeholder="Another opening scene…"
              ></textarea>
              <button type="button" class="ui-icon-button mt-1" onclick={() => removeGreeting(index)} aria-label="Remove greeting">
                <Trash2 class="size-4" />
              </button>
            </div>
          {/each}
        </div>
      {/if}

      {#if section === 'lore'}
        <LorebookEditor book={draft.book} onchange={(book) => set('book', book)} />
      {/if}
      {#if section === 'voice'}
        <VoiceAssignmentEditor value={draft.voice ?? (draft.voiceId ? { voice: draft.voiceId, backend: 'local' } : null)} label={$t('roleplay.voice.character')} previewText={draft.firstMessage || $t('roleplay.voice.preview', { values: { name: draft.name || '…' } })} onchange={(voice) => { set('voice', voice); set('voiceId', null); }} />
      {/if}

      {#if section === 'advanced'}
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Example dialogue</span>
          <span class="block text-xs text-muted-foreground">Teach the voice. Separate blocks with &lt;START&gt;.</span>
          <textarea class="ui-input min-h-28 resize-y" bind:value={draft.exampleDialogue} placeholder="<START>&#10;&#123;&#123;user&#125;&#125;: Rough day?&#10;&#123;&#123;char&#125;&#125;: &quot;Define rough.&quot;"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Character system prompt</span>
          <span class="block text-xs text-muted-foreground">Overrides the default roleplay instructions for this character.</span>
          <textarea class="ui-input min-h-20 resize-y" bind:value={draft.systemPrompt} placeholder="Optional"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Post-history instructions</span>
          <span class="block text-xs text-muted-foreground">Final, high-priority instructions sent after the chat history.</span>
          <textarea class="ui-input min-h-20 resize-y" bind:value={draft.postHistoryInstructions} placeholder="Optional"></textarea>
        </label>
        <label class="block space-y-1.5 text-sm">
          <span class="font-medium text-muted-foreground">Group talkativeness</span>
          <span class="block text-xs text-muted-foreground">How often this character speaks when nobody mentions them (0–100).</span>
          <input
            class="ui-input max-w-32"
            type="number"
            min="0"
            max="100"
            value={draft.talkativeness ?? 50}
            oninput={(e) => {
              const value = Number(e.currentTarget.value);
              set('talkativeness', Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50);
            }}
          />
        </label>
      {/if}
    </div>

    <div class="ui-modal-footer">
      {#if character && charactersStore.getById(character.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <button type="button" class="ui-btn ui-btn-ghost mr-auto text-error" onclick={() => character && deleteCharacter(character, onclose)}>{copy.actions.delete}</button>
      {/if}
      <button type="button" class="ui-btn ui-btn-ghost" onclick={() => guard.close(onclose)}>{copy.actions.cancel}</button>
      <Button onclick={() => void save()} disabled={saving}>{saving ? 'Saving…' : copy.actions.save}</Button>
    </div>
  </div>
</div>

<style>
  .avatar-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 5rem;
    height: 5rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    color: var(--text-muted);
    font-size: 1.5rem;
    font-weight: 600;
  }

  .avatar-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-upload {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .avatar-upload:hover {
    background: var(--surface-hover);
  }
</style>
