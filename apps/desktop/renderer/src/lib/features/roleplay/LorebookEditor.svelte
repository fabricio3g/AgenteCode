<svelte:options runes={true} />

<!--
  Lorebook editor.

  Two panes: entries on the left, the selected entry on the right. Used by both
  the character editor and the world editor, so every book is edited the same
  way. The parent owns persistence; this component only emits the next book.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { BookOpen, Copy, Plus, Trash2 } from 'lucide-svelte';
  import { Button, Select, Switch } from '$lib/components/ui';
  import type { CharacterBook, LorebookEntry } from '$lib/types/chat';
  import { emptyLoreEntry, normalizeBook } from '$lib/services/character-card';
  import { createId } from '$lib/utils/id';

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
      comment: `${source.comment || 'Entry'} copy`
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
    return entry.comment?.trim() || entry.keys[0] || 'Untitled entry';
  }

  function numberValue(event: Event): number | null {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    return Number.isFinite(value) ? value : null;
  }

  const logicOptions = [
    { value: 'and_any', label: 'Any secondary key' },
    { value: 'and_all', label: 'All secondary keys' },
    { value: 'not_any', label: 'No secondary key' },
    { value: 'not_all', label: 'Not all secondary keys' }
  ];
</script>

<div class="lorebook-editor flex min-h-0 flex-col gap-3">
  <div class="flex flex-wrap items-end gap-3">
    <label class="block min-w-0 flex-1 space-y-1.5 text-sm">
      <span class="text-xs font-medium text-muted-foreground">Book name</span>
      <input
        class="aui-input"
        value={draft.name || ''}
        oninput={(event) => updateBook({ name: event.currentTarget.value })}
        placeholder="Optional"
      />
    </label>
    <label class="block w-28 space-y-1.5 text-sm">
      <span class="text-xs font-medium text-muted-foreground">Scan depth</span>
      <input
        class="aui-input"
        type="number"
        min="1"
        value={draft.scanDepth ?? 4}
        oninput={(event) => updateBook({ scanDepth: numberValue(event) ?? 4 })}
      />
    </label>
    <label class="block w-32 space-y-1.5 text-sm">
      <span class="text-xs font-medium text-muted-foreground">Token budget</span>
      <input
        class="aui-input"
        type="number"
        min="0"
        value={draft.tokenBudget ?? 1024}
        oninput={(event) => updateBook({ tokenBudget: numberValue(event) ?? 0 })}
      />
    </label>
  </div>

  <div class="{heightClass} grid min-h-0 gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
    <!-- Entry list -->
    <div class="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)]">
      <div class="flex items-center justify-between border-b border-[var(--border-subtle)] px-2.5 py-1.5">
        <span class="text-xs font-medium text-muted-foreground">
          Entries {draft.entries.length ? `(${draft.entries.length})` : ''}
        </span>
        <button type="button" class="aui-icon-button is-xs" onclick={addEntry} aria-label="Add entry">
          <Plus class="size-3.5" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-1">
        {#if !draft.entries.length}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
            <BookOpen class="size-5 text-[var(--text-muted)]" />
            <p class="text-xs text-muted-foreground">No entries yet. Add one to teach the scene a fact.</p>
          </div>
        {:else}
          {#each draft.entries as entry (entry.id)}
            <button
              type="button"
              class="lore-entry-row {entry.id === selectedId ? 'is-active' : ''} {entry.enabled ? '' : 'is-off'}"
              onclick={() => (selectedId = entry.id)}
            >
              <span class="lore-entry-title">{entryTitle(entry)}</span>
              <span class="lore-entry-meta">
                {#if entry.constant}<span class="lore-badge">always</span>{/if}
                {#if entry.selective}<span class="lore-badge">filter</span>{/if}
                {#if entry.keys.length && !entry.constant}
                  <span class="truncate">{entry.keys.slice(0, 3).join(', ')}</span>
                {/if}
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Entry form -->
    <div class="min-h-0 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border)] p-3">
      {#if selected}
        <div class="space-y-3">
          <div class="flex items-start gap-2">
            <label class="block min-w-0 flex-1 space-y-1.5 text-sm">
              <span class="text-xs font-medium text-muted-foreground">Title</span>
              <input
                class="aui-input"
                value={selected.comment || ''}
                oninput={(event) => updateEntry(selected.id, { comment: event.currentTarget.value })}
                placeholder="What is this entry about?"
              />
            </label>
            <div class="flex items-center gap-1 pt-6">
              <button
                type="button"
                class="aui-icon-button"
                onclick={() => duplicateEntry(selected.id)}
                aria-label="Duplicate entry"
                title="Duplicate entry"
              >
                <Copy class="size-3.5" />
              </button>
              <button
                type="button"
                class="aui-icon-button text-error"
                onclick={() => removeEntry(selected.id)}
                aria-label="Delete entry"
                title="Delete entry"
              >
                <Trash2 class="size-3.5" />
              </button>
            </div>
          </div>

          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Keys</span>
            <input
              class="aui-input"
              value={keysToText(selected.keys)}
              oninput={(event) => updateEntry(selected.id, { keys: parseKeys(event.currentTarget.value) })}
              placeholder="comma, separated, words"
            />
            <span class="block text-[11px] text-muted-foreground">Injected when any key appears in the last messages.</span>
          </label>

          <label class="block space-y-1.5 text-sm">
            <span class="text-xs font-medium text-muted-foreground">Content</span>
            <textarea
              class="aui-input min-h-28 resize-y"
              value={selected.content}
              oninput={(event) => updateEntry(selected.id, { content: event.currentTarget.value })}
              placeholder="The fact to inject into the prompt."
            ></textarea>
          </label>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block space-y-1.5 text-sm">
              <span class="text-xs font-medium text-muted-foreground">Insertion order</span>
              <input
                class="aui-input"
                type="number"
                value={selected.insertionOrder ?? 100}
                oninput={(event) => updateEntry(selected.id, { insertionOrder: numberValue(event) ?? 100 })}
              />
            </label>
            <div class="flex flex-col justify-end gap-2 pb-0.5">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-medium text-muted-foreground">Always inject</span>
                <Switch
                  checked={!!selected.constant}
                  label="Always inject"
                  onchange={(checked) => updateEntry(selected.id, { constant: checked })}
                />
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-medium text-muted-foreground">Enabled</span>
                <Switch
                  checked={selected.enabled !== false}
                  label="Enabled"
                  onchange={(checked) => updateEntry(selected.id, { enabled: checked })}
                />
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
            <div class="min-w-0">
              <div class="text-xs font-medium text-foreground">Require a secondary key</div>
              <div class="text-[11px] text-muted-foreground">Only inject when the filter keys also match.</div>
            </div>
            <Switch
              checked={!!selected.selective}
              label="Require a secondary key"
              onchange={(checked) => updateEntry(selected.id, { selective: checked })}
            />
          </div>

          {#if selected.selective}
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)]">
              <label class="block space-y-1.5 text-sm">
                <span class="text-xs font-medium text-muted-foreground">Secondary keys</span>
                <input
                  class="aui-input"
                  value={keysToText(selected.secondaryKeys)}
                  oninput={(event) => updateEntry(selected.id, { secondaryKeys: parseKeys(event.currentTarget.value) })}
                  placeholder="comma, separated, words"
                />
              </label>
              <div class="space-y-1.5">
                <span class="text-xs font-medium text-muted-foreground">Logic</span>
                <Select
                  variant="surface"
                  value={selected.secondaryLogic || 'and_any'}
                  options={logicOptions}
                  aria-label="Secondary key logic"
                  onchange={(value) => updateEntry(selected.id, { secondaryLogic: value as LorebookEntry['secondaryLogic'] })}
                />
              </div>
            </div>
          {/if}

          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-center gap-2">
              <Switch
                checked={!!selected.useRegex}
                label="Keys are regular expressions"
                onchange={(checked) => updateEntry(selected.id, { useRegex: checked })}
              />
              <span class="text-xs text-muted-foreground">Keys are regex</span>
            </div>
            <div class="flex items-center gap-2">
              <Switch
                checked={!!selected.caseSensitive}
                label="Case sensitive keys"
                onchange={(checked) => updateEntry(selected.id, { caseSensitive: checked })}
              />
              <span class="text-xs text-muted-foreground">Case sensitive</span>
            </div>
          </div>
        </div>
      {:else}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
          <BookOpen class="size-5 text-[var(--text-muted)]" />
          <p class="text-xs text-muted-foreground">Select an entry to edit it, or add a new one.</p>
          <Button variant="secondary" onclick={addEntry}>Add entry</Button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .lore-entry-row {
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

  .lore-entry-row:hover {
    background: var(--surface-hover);
  }

  .lore-entry-row.is-active {
    border-color: var(--border);
    background: var(--surface-active);
  }

  .lore-entry-row.is-off {
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
    font-size: 0.625rem;
  }

  .lore-badge {
    flex-shrink: 0;
    padding: 0 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: 0.5625rem;
    line-height: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
</style>
