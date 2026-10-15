<svelte:options runes={true} />

<!--
  Lorebook editor.

  Two panes: entries on the left, the selected entry on the right. Used by both
  the character editor and the world editor, so every book is edited the same
  way. The parent owns persistence; this component only emits the next book.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { BookOpen, Copy, Plus, Trash2 } from 'lucide-svelte';
  import { Button, Select, Switch, Tooltip } from '$lib/components/ui';
  import type { CharacterBook, LorebookEntry } from '$lib/types/chat';
  import { emptyLoreEntry, normalizeBook } from '$lib/services/character-card';
  import { createId } from '$lib/utils/id';
  import { t } from 'svelte-i18n';

  interface Props {
    book?: CharacterBook | null;
    onchange: (book: CharacterBook) => void;
    /** Rendered as a fixed-height pane inside a modal tab. */
    heightClass?: string;
  }

  let { book = null, onchange, heightClass = 'h-[46vh]' }: Props = $props();

  // Snapshot once: the editor owns its working copy and emits on every change.
  const initialBook = untrack(() => normalizeBook(book));
  let draft = $state<CharacterBook>(initialBook);
  let selectedId = $state<string | null>(initialBook.entries[0]?.id ?? null);

  const selected = $derived(draft.entries.find((entry) => entry.id === selectedId) ?? null);

  function emit() {
    onchange(draft);
  }

  function updateBook(patch: Partial<CharacterBook>) {
    draft = { ...draft, ...patch };
    emit();
  }

  function updateEntry(id: string, patch: Partial<LorebookEntry>) {
    draft = {
      ...draft,
      entries: draft.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    };
    emit();
  }

  function addEntry() {
    const entry = emptyLoreEntry();
    draft = { ...draft, entries: [...draft.entries, entry] };
    selectedId = entry.id;
    emit();
  }

  function duplicateEntry(id: string) {
    const source = draft.entries.find((entry) => entry.id === id);
    if (!source) return;
    const copy: LorebookEntry = {
      ...source,
      id: createId('lore'),
      comment: `${source.comment || $t('roleplay.lore.entry')} ${$t('roleplay.lore.copySuffix')}`
    };
    draft = { ...draft, entries: [...draft.entries, copy] };
    selectedId = copy.id;
    emit();
  }

  function removeEntry(id: string) {
    const index = draft.entries.findIndex((entry) => entry.id === id);
    draft = { ...draft, entries: draft.entries.filter((entry) => entry.id !== id) };
    if (selectedId === id) {
      selectedId = draft.entries[Math.max(0, index - 1)]?.id ?? draft.entries[0]?.id ?? null;
    }
    emit();
  }

  function keysToText(keys: string[] | undefined): string {
    return (keys || []).join(', ');
  }

  function parseKeys(raw: string): string[] {
    return raw.split(',').map((key) => key.trim()).filter(Boolean);
  }

  function entryTitle(entry: LorebookEntry): string {
    return entry.comment?.trim() || entry.keys[0] || $t('roleplay.lore.untitled');
  }

  function numberValue(event: Event): number | null {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    return Number.isFinite(value) ? value : null;
  }

  const logicOptions = $derived([
    { value: 'and_any', label: $t('roleplay.lore.logic.andAny') },
    { value: 'and_all', label: $t('roleplay.lore.logic.andAll') },
    { value: 'not_any', label: $t('roleplay.lore.logic.notAny') },
    { value: 'not_all', label: $t('roleplay.lore.logic.notAll') }
  ]);
</script>

<div class="lorebook-editor flex min-h-0 flex-col gap-3">
  <div class="{heightClass} grid min-h-0 gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
    <!-- Entry list -->
    <div class="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
      <div class="flex items-center justify-between px-3 py-2">
        <span class="text-xs font-medium text-muted-foreground">
          {$t('roleplay.lore.entries')}{draft.entries.length ? ` · ${draft.entries.length}` : ''}
        </span>
        <Tooltip label={$t('roleplay.lore.add')} position="bottom"><UiIconButton label={$t('roleplay.lore.add')} size="xs" type="button" class={uiClass(" ", "ui-local-fa92d110")} onclick={addEntry} >
          <Plus class="size-3.5" />
        </UiIconButton></Tooltip>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {#if !draft.entries.length}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
            <BookOpen class="size-5 text-[var(--text-muted)]" />
            <p class="text-xs text-muted-foreground">{$t('roleplay.lore.empty')}</p>
          </div>
        {:else}
          {#each draft.entries as entry (entry.id)}
            <Button variant="plain"
              type="button"
              class={uiClass(`lore-entry-row ${entry.id === selectedId ? 'is-active' : ''} ${entry.enabled ? '' : 'is-off'}`, "ui-local-fa92d110")}
              aria-current={entry.id === selectedId ? 'true' : undefined}
              onclick={() => (selectedId = entry.id)}
            >
              <span class="lore-entry-title">{entryTitle(entry)}</span>
              <span class="lore-entry-meta">
                {#if entry.constant}<span class="lore-badge">{$t('roleplay.lore.always')}</span>{/if}
                {#if entry.selective}<span class="lore-badge">{$t('roleplay.lore.needsSecond')}</span>{/if}
                {#if entry.keys.length && !entry.constant}
                  <span class="truncate">{entry.keys.slice(0, 3).join(', ')}</span>
                {/if}
              </span>
            </Button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Entry form -->
    <div class="min-h-0 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3">
      {#if selected}
        <div class="space-y-3">
          <div class="flex items-start gap-2">
            <label class="block min-w-0 flex-1 space-y-1.5 text-sm">
              <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.entryName')}</span>
              <UiInput
                class={uiClass("", "ui-local-fa92d110")}
                value={selected.comment || ''}
                oninput={(event) => updateEntry(selected.id, { comment: event.currentTarget.value })}
                placeholder={$t('roleplay.lore.entryNamePlaceholder')}
              />
            </label>
            <div class="flex items-center gap-1 pt-6">
              <Tooltip label={$t('roleplay.lore.duplicate')} position="bottom"><UiIconButton label={$t('roleplay.lore.duplicate')} size="sm" type="button" class={uiClass("", "ui-local-fa92d110")} onclick={() => duplicateEntry(selected.id)} >
                <Copy class="size-3.5" />
              </UiIconButton></Tooltip>
              <Tooltip label={$t('roleplay.lore.delete')} position="bottom"><UiIconButton label={$t('roleplay.lore.delete')} size="sm" type="button" class={uiClass(" hover:text-error", "ui-local-fa92d110")} onclick={() => removeEntry(selected.id)} >
                <Trash2 class="size-3.5" />
              </UiIconButton></Tooltip>
            </div>
          </div>

          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.triggers')}</span>
            <UiInput
              class={uiClass("", "ui-local-fa92d110")}
              value={keysToText(selected.keys)}
              oninput={(event) => updateEntry(selected.id, { keys: parseKeys(event.currentTarget.value) })}
              placeholder={$t('roleplay.lore.triggersPlaceholder')}
            />
            <span class="block text-[length:var(--text-xs)] text-muted-foreground">{$t('roleplay.lore.triggersHint')}</span>
          </label>

          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.content')}</span>
            <UiTextarea
              class={uiClass(" min-h-28 resize-y", "ui-local-fa92d110")}
              value={selected.content}
              oninput={(event) => updateEntry(selected.id, { content: event.currentTarget.value })}
              placeholder={$t('roleplay.lore.contentPlaceholder')}
            ></UiTextarea>
          </label>

          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-foreground">{$t('roleplay.lore.always')}</div>
                <div class="text-[length:var(--text-xs)] text-muted-foreground">{$t('roleplay.lore.alwaysHint')}</div>
              </div>
              <Switch checked={!!selected.constant} label={$t('roleplay.lore.always')} onchange={(checked) => updateEntry(selected.id, { constant: checked })} />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-foreground">{$t('roleplay.lore.needsSecond')}</div>
                <div class="text-[length:var(--text-xs)] text-muted-foreground">{$t('roleplay.lore.needsSecondHint')}</div>
              </div>
              <Switch checked={!!selected.selective} label={$t('roleplay.lore.needsSecond')} onchange={(checked) => updateEntry(selected.id, { selective: checked })} />
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs font-medium text-foreground">{$t('roleplay.lore.enabled')}</span>
              <Switch checked={selected.enabled !== false} label={$t('roleplay.lore.enabled')} onchange={(checked) => updateEntry(selected.id, { enabled: checked })} />
            </div>
          </div>

          {#if selected.selective}
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)]">
              <label class="block space-y-1.5 text-sm">
                <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.also')}</span>
                <UiInput
                  class={uiClass("", "ui-local-fa92d110")}
                  value={keysToText(selected.secondaryKeys)}
                  oninput={(event) => updateEntry(selected.id, { secondaryKeys: parseKeys(event.currentTarget.value) })}
                  placeholder={$t('roleplay.lore.triggersPlaceholder')}
                />
              </label>
              <div class="space-y-1.5">
                <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.logicLabel')}</span>
                <Select
                  variant="surface"
                  value={selected.secondaryLogic || 'and_any'}
                  options={logicOptions}
                  aria-label={$t('roleplay.lore.logicLabel')}
                  onchange={(value) => updateEntry(selected.id, { secondaryLogic: value as LorebookEntry['secondaryLogic'] })}
                />
              </div>
            </div>
          {/if}

          <details class="advanced">
            <summary>{$t('roleplay.advanced')}</summary>
            <div class="advanced-body">
              <label class="block space-y-1.5 text-sm">
                <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.order')}</span>
                <UiInput
                  class={uiClass(" max-w-40", "ui-local-fa92d110")}
                  type="number"
                  value={selected.insertionOrder ?? 100}
                  oninput={(event) => updateEntry(selected.id, { insertionOrder: numberValue(event) ?? 100 })}
                />
              </label>
              <div class="flex flex-wrap items-center gap-4">
                <div class="flex items-center gap-2">
                  <Switch checked={!!selected.useRegex} label={$t('roleplay.lore.regex')} onchange={(checked) => updateEntry(selected.id, { useRegex: checked })} />
                  <span class="text-xs text-muted-foreground">{$t('roleplay.lore.regex')}</span>
                </div>
                <div class="flex items-center gap-2">
                  <Switch checked={!!selected.caseSensitive} label={$t('roleplay.lore.caseSensitive')} onchange={(checked) => updateEntry(selected.id, { caseSensitive: checked })} />
                  <span class="text-xs text-muted-foreground">{$t('roleplay.lore.caseSensitive')}</span>
                </div>
              </div>
            </div>
          </details>
        </div>
      {:else}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
          <BookOpen class="size-5 text-[var(--text-muted)]" />
          <p class="text-xs text-muted-foreground">{$t('roleplay.lore.pick')}</p>
          <Button variant="secondary" onclick={addEntry}>{$t('roleplay.lore.add')}</Button>
        </div>
      {/if}
    </div>
  </div>

  <details class="advanced">
    <summary>{$t('roleplay.advanced')}</summary>
    <div class="advanced-body grid gap-3 sm:grid-cols-3">
      <label class="block space-y-1.5 text-sm sm:col-span-3">
        <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.bookName')}</span>
        <UiInput
          class={uiClass("", "ui-local-fa92d110")}
          value={draft.name || ''}
          oninput={(event) => updateBook({ name: event.currentTarget.value })}
          placeholder={$t('roleplay.optional')}
        />
      </label>
      <label class="block space-y-1.5 text-sm">
        <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.scanDepth')}</span>
        <UiInput
          class={uiClass("", "ui-local-fa92d110")}
          type="number"
          min="1"
          value={draft.scanDepth ?? 4}
          oninput={(event) => updateBook({ scanDepth: numberValue(event) ?? 4 })}
        />
        <span class="block text-[length:var(--text-xs)] text-muted-foreground">{$t('roleplay.lore.scanDepthHint')}</span>
      </label>
      <label class="block space-y-1.5 text-sm">
        <span class="text-xs font-medium text-muted-foreground">{$t('roleplay.lore.tokenBudget')}</span>
        <UiInput
          class={uiClass("", "ui-local-fa92d110")}
          type="number"
          min="0"
          value={draft.tokenBudget ?? 1024}
          oninput={(event) => updateBook({ tokenBudget: numberValue(event) ?? 0 })}
        />
      </label>
    </div>
  </details>
</div>

<style>
  .advanced {
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
  }

  .advanced summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .advanced summary:hover {
    color: var(--foreground);
  }

  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.625rem 0 0.25rem;
  }

  :is(.lore-entry-row, :global(.lore-entry-row.ui-local-fa92d110)) {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  :is(.lore-entry-row:hover, :global(.lore-entry-row:hover.ui-local-fa92d110)) {
    background: var(--surface-hover);
  }

  :is(.lore-entry-row.is-active, :global(.lore-entry-row.is-active.ui-local-fa92d110)) {
    border-color: var(--border);
    background: var(--surface-active);
  }

  :is(.lore-entry-row.is-off, :global(.lore-entry-row.is-off.ui-local-fa92d110)) {
    opacity: 0.5;
  }

  .lore-entry-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .lore-entry-meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .lore-badge {
    flex-shrink: 0;
    padding: 0 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    line-height: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
</style>
