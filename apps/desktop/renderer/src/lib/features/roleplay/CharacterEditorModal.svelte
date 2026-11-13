
<svelte:options runes={true} />

<!--
  Character editor.

  Six short tabs, in the order a card is written: who they are, how they open
  a scene, how they talk, what the world knows about them, how they sound, and
  the advanced fields. A preview beside the form shows the opening as the scene
  will read it, with the names resolved. Field names follow the community
  Character Card spec underneath, so cards import and export unchanged.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import DialogFooter from '$lib/components/ui/DialogFooter.svelte';

  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { deleteCharacter } from './library-actions.svelte';
  import { untrack } from 'svelte';
  import { X, Plus, Trash2, Upload, ChevronDown, ChevronUp } from '$lib/icons';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button, IconButton, Select, Tooltip } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { CharacterCard } from '$lib/types/chat';
  import { charactersStore, emptyCharacter } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import LorebookEditor from './LorebookEditor.svelte';
  import MacroField from './MacroField.svelte';
  import { parseExchanges, serializeExchanges, type Exchange, type Speaker } from './example-dialogue';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import VoiceAssignmentEditor from '$lib/components/settings/voice/VoiceAssignmentEditor.svelte';
  import { t } from 'svelte-i18n';
  import { renderMarkdown } from '$lib/utils/markdown';

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
  type Tab = 'basics' | 'openings' | 'talk' | 'lore' | 'voice' | 'advanced';
  let tab = $state<Tab>('basics');
  let moreOpen = $state(false);
  let openingIndex = $state(0);

  /** Sample exchanges, edited as a list; written back to the card's text on every change. */
  let exchanges = $state<Exchange[]>(untrack(() => parseExchanges(draft.exampleDialogue)));

  const isNew = $derived(!character);
  const userName = $derived(charactersStore.defaultPersona?.name?.trim() || $t('roleplay.you'));
  const charName = $derived(draft.name?.trim() || $t('roleplay.character.unnamed'));
  const openings = $derived([draft.firstMessage, ...draft.alternateGreetings]);
  const greetingPreview = $derived(
    roleplayStore.previewText(openings[openingIndex] ?? '', { char: charName, seed: draft.id })
  );

  function set<K extends keyof CharacterCard>(key: K, value: CharacterCard[K]) {
    draft = { ...draft, [key]: value };
  }

  function updateTags(raw: string) {
    set('tags', raw.split(',').map((tag) => tag.trim()).filter(Boolean));
  }

  function setOpening(index: number, value: string) {
    if (index === 0) set('firstMessage', value);
    else set('alternateGreetings', draft.alternateGreetings.map((text, i) => (i === index - 1 ? value : text)));
  }

  function addOpening() {
    set('alternateGreetings', [...draft.alternateGreetings, '']);
    openingIndex = draft.alternateGreetings.length;
  }

  function removeOpening(index: number) {
    if (index === 0) {
      // The first opening cannot disappear: the next one takes its place.
      const [next, ...rest] = draft.alternateGreetings;
      set('firstMessage', next ?? '');
      set('alternateGreetings', rest);
    } else {
      set('alternateGreetings', draft.alternateGreetings.filter((_, i) => i !== index - 1));
    }
    openingIndex = Math.max(0, Math.min(openingIndex, openings.length - 2));
  }

  function writeExchanges(next: Exchange[]) {
    exchanges = next;
    set('exampleDialogue', serializeExchanges(next));
  }

  function updateLine(exchangeIndex: number, lineIndex: number, patch: Partial<{ speaker: Speaker; text: string }>) {
    writeExchanges(exchanges.map((exchange, i) => i !== exchangeIndex ? exchange : {
      ...exchange,
      lines: exchange.lines.map((line, j) => (j === lineIndex ? { ...line, ...patch } : line))
    }));
  }

  function addLine(exchangeIndex: number) {
    const last = exchanges[exchangeIndex]?.lines.at(-1)?.speaker;
    const speaker: Speaker = last === 'user' ? 'char' : 'user';
    writeExchanges(exchanges.map((exchange, i) => (i === exchangeIndex ? { ...exchange, lines: [...exchange.lines, { speaker, text: '' }] } : exchange)));
  }

  function removeLine(exchangeIndex: number, lineIndex: number) {
    writeExchanges(exchanges.map((exchange, i) => (i === exchangeIndex ? { ...exchange, lines: exchange.lines.filter((_, j) => j !== lineIndex) } : exchange))
      .filter((exchange) => exchange.lines.length));
  }

  function addExchange() {
    writeExchanges([...exchanges, { id: `exchange-new-${exchanges.length}-${Date.now().toString(36)}`, lines: [{ speaker: 'user', text: '' }, { speaker: 'char', text: '' }] }]);
  }

  function speakerOptions(speaker: Speaker) {
    const options = [
      { value: 'user', label: userName },
      { value: 'char', label: charName }
    ];
    if (speaker.startsWith('name:') && !options.some((option) => option.value === speaker)) {
      options.push({ value: speaker, label: speaker.slice('name:'.length) });
    }
    return options;
  }

  async function onAvatarPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toastStore.error($t('roleplay.character.avatarTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('avatar', String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!draft.name.trim()) {
      toastStore.error($t('roleplay.character.nameRequired'));
      tab = 'basics';
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

  const tabs = $derived<Array<{ value: Tab; label: string }>>(
    (['basics', 'openings', 'talk', 'lore', 'voice', 'advanced'] as const).map((value) => ({ value, label: $t(`roleplay.character.tab.${value}`) }))
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
    class="ui-modal-surface character-surface"
    role="dialog"
    aria-modal="true"
    aria-label={isNew ? $t('roleplay.character.newTitle') : charName}
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{isNew ? $t('roleplay.character.newTitle') : charName}</div>
        <div class="text-xs text-muted-foreground">{$t('roleplay.character.subtitle')}</div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><IconButton label={copy.actions.close} size="sm" type="button" class={uiClass("", "ui-local-078abba6")} onclick={() => guard.close(onclose)} >
        <X class="size-4" />
      </IconButton></Tooltip>
    </div>

    <div class="tabs-row">
      <SegmentedControl value={tab} options={tabs} label={$t('roleplay.character.title')} variant="tabs" shape="rect" onchange={(value) => (tab = value as Tab)} />
    </div>

    <div class="editor-body">
      <div class="form ui-modal-body space-y-4">
        {#if tab === 'basics'}
          <div class="flex items-start gap-4">
            <div class="flex flex-col items-center gap-2">
              <div class="avatar-preview">
                {#if draft.avatar}
                  <img src={draft.avatar} alt={charName} />
                {:else}
                  <span>{draft.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
                {/if}
              </div>
              <label class="avatar-upload">
                <Upload class="size-3.5" />
                <span>{$t('roleplay.character.upload')}</span>
                <UiFileInput class={uiClass("hidden", "ui-local-078abba6")}  accept="image/*" onchange={onAvatarPicked} />
              </label>
            </div>
            <div class="grid min-w-0 flex-1 gap-3">
              <label class="block space-y-1.5 text-sm">
                <span class="field-label">{$t('roleplay.character.name')}</span>
                <UiInput class={uiClass("", "ui-local-078abba6")} bind:value={draft.name} placeholder={$t('roleplay.character.namePlaceholder')} />
              </label>
              <label class="block space-y-1.5 text-sm">
                <span class="field-label">{$t('roleplay.character.tagline')}</span>
                <UiInput class={uiClass("", "ui-local-078abba6")} bind:value={draft.tagline} placeholder={$t('roleplay.character.taglinePlaceholder')} />
              </label>
            </div>
          </div>

          <MacroField
            label={$t('roleplay.character.about')}
            hint={$t('roleplay.character.aboutHint')}
            value={draft.description}
            char={charName}
            user={userName}
            rows={6}
            placeholder={$t('roleplay.character.aboutPlaceholder')}
            onchange={(value) => set('description', value)}
          />

          <Button variant="plain" type="button" class={uiClass("more-toggle", "ui-local-078abba6")} aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)}>
            {#if moreOpen}<ChevronUp class="size-3.5" />{:else}<ChevronDown class="size-3.5" />{/if}
            <span>{moreOpen ? $t('roleplay.character.less') : $t('roleplay.character.more')}</span>
          </Button>
          {#if moreOpen}
            <div class="space-y-4">
              <MacroField
                label={$t('roleplay.character.personality')}
                hint={$t('roleplay.character.personalityHint')}
                value={draft.personality}
                char={charName}
                user={userName}
                rows={3}
                onchange={(value) => set('personality', value)}
              />
              <MacroField
                label={$t('roleplay.character.scenario')}
                hint={$t('roleplay.character.scenarioHint')}
                value={draft.scenario}
                char={charName}
                user={userName}
                rows={3}
                onchange={(value) => set('scenario', value)}
              />
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block space-y-1.5 text-sm">
                  <span class="field-label">{$t('roleplay.character.nickname')}</span>
                  <UiInput class={uiClass("", "ui-local-078abba6")} value={draft.nickname || ''} oninput={(e) => set('nickname', e.currentTarget.value)} placeholder={$t('roleplay.optional')} />
                </label>
                <label class="block space-y-1.5 text-sm">
                  <span class="field-label">{$t('roleplay.character.aliases')}</span>
                  <UiInput class={uiClass("", "ui-local-078abba6")} value={(draft.aliases ?? []).join(', ')} placeholder={$t('roleplay.character.aliasesPlaceholder')} oninput={(event) => set('aliases', event.currentTarget.value.split(',').map((name) => name.trim()).filter(Boolean))} />
                </label>
                <label class="block space-y-1.5 text-sm">
                  <span class="field-label">{$t('roleplay.character.tags')}</span>
                  <UiInput class={uiClass("", "ui-local-078abba6")} value={draft.tags.join(', ')} oninput={(e) => updateTags(e.currentTarget.value)} placeholder="fantasy, slice-of-life" />
                </label>
                <label class="block space-y-1.5 text-sm">
                  <span class="field-label">{$t('roleplay.character.creator')}</span>
                  <UiInput class={uiClass("", "ui-local-078abba6")} bind:value={draft.creator} placeholder={$t('roleplay.character.creatorPlaceholder')} />
                </label>
              </div>
            </div>
          {/if}
        {/if}

        {#if tab === 'openings'}
          <p class="section-hint">{$t('roleplay.character.openingsHint')}</p>
          {#each openings as opening, index (index)}
            <div class="opening-row {index === openingIndex ? 'is-selected' : ''}">
              <div class="min-w-0 flex-1">
                <MacroField
                  label={index === 0 ? $t('roleplay.character.openingFirst') : $t('roleplay.character.openingN', { values: { n: index + 1 } })}
                  value={opening}
                  char={charName}
                  user={userName}
                  rows={4}
                  placeholder={$t('roleplay.character.openingPlaceholder')}
                  onchange={(value) => setOpening(index, value)}
                />
              </div>
              {#if index > 0 || openings.length > 1}
                <Tooltip label={$t('roleplay.character.removeOpening')} position="bottom"><IconButton label={$t('roleplay.character.removeOpening')} title="" class="mt-6 hover:text-error" onclick={() => removeOpening(index)}>
                  <Trash2 />
                </IconButton></Tooltip>
              {/if}
            </div>
          {/each}
          <Button variant="outline" size="sm" type="button" onclick={addOpening}>
            <Plus class="size-3.5" /> {$t('roleplay.character.addOpening')}
          </Button>
        {/if}

        {#if tab === 'talk'}
          <p class="section-hint">{$t('roleplay.character.talkHint')}</p>
          {#each exchanges as exchange, exchangeIndex (exchange.id)}
            <div class="exchange">
              <div class="exchange-head">
                <span class="exchange-title">{$t('roleplay.character.exampleN', { values: { n: exchangeIndex + 1 } })}</span>
                <Tooltip label={$t('roleplay.character.removeExample')} position="bottom"><IconButton label={$t('roleplay.character.removeExample')} title="" class="hover:text-error" onclick={() => writeExchanges(exchanges.filter((_, i) => i !== exchangeIndex))}>
                  <Trash2 />
                </IconButton></Tooltip>
              </div>
              {#each exchange.lines as line, lineIndex (lineIndex)}
                <div class="line-row">
                  <div class="line-speaker">
                    <Select
                      variant="surface"
                      value={line.speaker}
                      options={speakerOptions(line.speaker)}
                      aria-label={$t('roleplay.character.speaker')}
                      onchange={(value) => updateLine(exchangeIndex, lineIndex, { speaker: value as Speaker })}
                    />
                  </div>
                  <UiTextarea
                    class={uiClass(" line-text", "ui-local-078abba6")}
                    rows={2}
                    value={line.text}
                    aria-label={$t('roleplay.character.lineText')}
                    placeholder={$t('roleplay.character.linePlaceholder')}
                    oninput={(event) => updateLine(exchangeIndex, lineIndex, { text: event.currentTarget.value })}
                  ></UiTextarea>
                  <IconButton label={$t('roleplay.character.removeLine')} title="" class="hover:text-error" onclick={() => removeLine(exchangeIndex, lineIndex)}>
                    <X />
                  </IconButton>
                </div>
              {/each}
              <Button variant="ghost" size="xs" type="button" onclick={() => addLine(exchangeIndex)}>
                <Plus class="size-3" /> {$t('roleplay.character.addLine')}
              </Button>
            </div>
          {/each}
          {#if !exchanges.length}
            <p class="empty-note">{$t('roleplay.character.talkEmpty')}</p>
          {/if}
          <Button variant="outline" size="sm" type="button" onclick={addExchange}>
            <Plus class="size-3.5" /> {$t('roleplay.character.addExample')}
          </Button>
        {/if}

        {#if tab === 'lore'}
          <LorebookEditor book={draft.book} onchange={(book) => set('book', book)} heightClass="h-[46vh]" />
        {/if}

        {#if tab === 'voice'}
          <VoiceAssignmentEditor value={draft.voice ?? (draft.voiceId ? { voice: draft.voiceId, backend: 'local' } : null)} label={$t('roleplay.voice.character')} previewText={roleplayStore.previewText(openings[0] ?? '', { char: charName, seed: draft.id }) || $t('roleplay.voice.preview', { values: { name: charName } })} onchange={(voice) => { set('voice', voice); set('voiceId', null); }} />
        {/if}

        {#if tab === 'advanced'}
          <MacroField
            label={$t('roleplay.character.systemPrompt')}
            hint={$t('roleplay.character.systemPromptHint')}
            value={draft.systemPrompt}
            char={charName}
            user={userName}
            rows={3}
            placeholder={$t('roleplay.optional')}
            onchange={(value) => set('systemPrompt', value)}
          />
          <MacroField
            label={$t('roleplay.character.afterChat')}
            hint={$t('roleplay.character.afterChatHint')}
            value={draft.postHistoryInstructions}
            char={charName}
            user={userName}
            rows={3}
            placeholder={$t('roleplay.optional')}
            onchange={(value) => set('postHistoryInstructions', value)}
          />
          <label class="block space-y-1.5 text-sm">
            <span class="field-label">{$t('roleplay.character.talkativeness')}</span>
            <span class="block text-xs text-muted-foreground">{$t('roleplay.character.talkativenessHint')}</span>
            <UiInput
              class={uiClass(" max-w-32", "ui-local-078abba6")}
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
          <p class="text-xs text-muted-foreground">
            {$t('roleplay.character.cardFormat', { values: { format: draft.spec === 'chara_card_v3' ? 'V3' : draft.spec === 'chara_card_v2' ? 'V2' : $t('roleplay.character.cardFormatNew') } })}
          </p>
        {/if}
      </div>

      <aside class="preview" aria-label={$t('roleplay.character.preview')}>
        <div class="preview-head">
          <span class="preview-avatar"><Avatar size="fill" name={charName} image={draft.avatar} /></span>
          <span class="min-w-0 truncate text-sm font-medium text-foreground">{charName}</span>
        </div>
        <div class="preview-label">{$t('roleplay.character.previewLabel')}</div>
        {#if openings[openingIndex]?.trim()}
          <div class="preview-bubble markdown-body">{@html renderMarkdown(greetingPreview, { breaks: true })}</div>
          {#if openings.length > 1}
            <div class="preview-pager">
              <Button variant="ghost" size="xs" type="button" disabled={openingIndex === 0} aria-label={$t('roleplay.swipe.previous')} onclick={() => (openingIndex -= 1)}>‹</Button>
              <span class="text-xs text-muted-foreground tabular-nums">{openingIndex + 1} / {openings.length}</span>
              <Button variant="ghost" size="xs" type="button" disabled={openingIndex >= openings.length - 1} aria-label={$t('roleplay.swipe.next')} onclick={() => (openingIndex += 1)}>›</Button>
            </div>
          {/if}
        {:else}
          <p class="preview-empty">{$t('roleplay.character.previewEmpty')}</p>
        {/if}
        <p class="preview-note">{$t('roleplay.character.previewNote')}</p>
      </aside>
    </div>

    <DialogFooter >
      {#if character && charactersStore.getById(character.id)}
        <!-- Deleting skips the unsaved-changes guard: the item is going away. -->
        <Button variant="outline" size="sm" class="mr-auto hover:text-error" type="button" onclick={() => character && deleteCharacter(character, onclose)}>{copy.actions.delete}</Button>
      {/if}
      <DialogActions cancelLabel={copy.actions.cancel} confirmLabel={saving ? $t('roleplay.saving') : copy.actions.save} oncancel={() => guard.close(onclose)} onconfirm={() => void save()} busy={saving} />
    </DialogFooter>
  </div>
</div>

<style>
  .character-surface {
    max-width: 58rem;
    width: min(58rem, calc(100vw - 2rem));
  }

  .tabs-row {
    padding: 0.5rem 1.25rem 0.25rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .editor-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 15rem;
    min-height: 0;
  }

  .form {
    min-width: 0;
    max-height: 62vh;
    overflow-y: auto;
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    border-left: 1px solid var(--border-subtle);
    background: var(--surface-hover);
    overflow-y: auto;
    max-height: 62vh;
  }

  .preview-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .preview-avatar {
    display: flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
  }

  .preview-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .preview-bubble {
    max-height: 19rem;
    overflow-y: auto;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-xl);
    background: color-mix(in srgb, var(--foreground) 3.5%, transparent);
    color: var(--foreground);
    font-size: var(--text-sm);
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .preview-pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
  }

  .preview-empty,
  .preview-note,
  .empty-note,
  .section-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .preview-note {
    margin-top: auto;
  }

  .field-label {
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  :global(.more-toggle.ui-local-078abba6) {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    align-self: flex-start;
    padding: 0.25rem 0.1rem;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  :global(.more-toggle:hover.ui-local-078abba6) {
    color: var(--foreground);
  }

  .avatar-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 4.5rem;
    height: 4.5rem;
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
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .avatar-upload:hover {
    background: var(--surface-hover);
  }

  .opening-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.625rem;
    border-radius: var(--radius-lg);
    background: var(--surface-hover);
  }

  .opening-row.is-selected {
    background: var(--surface-active);
  }

  .exchange {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.625rem;
    border-radius: var(--radius-lg);
    background: var(--surface-hover);
  }

  .exchange-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .exchange-title {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .line-row {
    display: grid;
    grid-template-columns: 9.5rem minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.4rem;
  }

  :global(.line-text.ui-local-078abba6) {
    min-height: 2.5rem;
    resize: vertical;
  }

  @media (max-width: 760px) {
    .editor-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .preview {
      display: none;
    }
    .line-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .line-speaker {
      grid-column: 1 / -1;
    }
  }
</style>
