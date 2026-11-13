
<svelte:options runes={true} />

<!--
  Scene memory: what this scene keeps, in the hands of the person writing it.

  Pinned memories go into every reply's prompt first; the rest of the journal
  (handouts from the scene, leads, bonds, notes) is recalled while it is
  pinned. The story so far is the running summary. Every entry can be edited
  and removed here, and the reply line "Remembered" lists what a turn drew on.
-->

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { Pencil, Pin, PinOff, Plus, RefreshCw, Trash2, X } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { copy as copyText } from '$lib/copy';
  import type { RoleplayJournalEntry } from '$lib/types/chat';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const KINDS: Array<RoleplayJournalEntry['kind']> = ['prop', 'quest', 'bond', 'note'];

  const entries = $derived(appStore.currentChat?.roleplay?.journal ?? []);
  const summary = $derived(appStore.currentChat?.roleplay?.storySummary?.text ?? '');
  const summarizing = $derived(!!roleplayStore.summarizing[appStore.currentChatId || '']);

  const pinned = $derived(
    entries.filter((entry) => entry.pinned).sort((a, b) => b.createdAt - a.createdAt)
  );
  const grouped = $derived(
    KINDS.map((kind) => ({
      kind,
      entries: entries
        .filter((entry) => entry.kind === kind && !entry.pinned)
        .sort((a, b) => b.createdAt - a.createdAt)
    })).filter((section) => section.entries.length > 0)
  );

  let adding = $state(false);
  let draftKind = $state<RoleplayJournalEntry['kind']>('note');
  let draftTitle = $state('');
  let draftBody = $state('');
  let editingId = $state<string | null>(null);
  let editTitle = $state('');
  let editBody = $state('');

  function add() {
    const title = draftTitle.trim();
    const body = draftBody.trim();
    if (!title && !body) return;
    roleplayStore.addJournalEntry({ kind: draftKind, title: title || $t('roleplay.journal.untitled'), body, pinned: true });
    draftTitle = '';
    draftBody = '';
    adding = false;
  }

  /** A memory pinned from a line carries that line as its title; showing both twice reads as noise. */
  function titleIsBody(entry: RoleplayJournalEntry): boolean {
    const plain = (text: string) => text.replace(/[*_~`#>]+/g, '').replace(/\s+/g, ' ').trim();
    const head = plain(entry.title.replace(/…$/, ''));
    return !!entry.body && !!head && plain(entry.body).startsWith(head);
  }

  function startEdit(entry: RoleplayJournalEntry) {
    editingId = entry.id;
    editTitle = entry.title;
    editBody = entry.body;
  }

  function saveEdit(entry: RoleplayJournalEntry) {
    const title = editTitle.trim() || entry.title;
    roleplayStore.editJournalEntry(entry.id, { title, body: editBody.trim() });
    editingId = null;
  }

  /** A memory as the viewer reads it: resolved in the turn it came from, else in the scene. */
  function shown(entry: RoleplayJournalEntry, value: string): string {
    return roleplayStore.displayText(value, { messageId: entry.messageId, seed: entry.id, at: entry.createdAt });
  }

  function remove(entry: RoleplayJournalEntry) {
    confirmStore.show({
      title: $t('roleplay.journal.removeTitle'),
      message: $t('roleplay.journal.removeMessage', { values: { title: entry.title } }),
      confirmLabel: $t('roleplay.journal.remove'),
      danger: true,
      onConfirm: () => roleplayStore.removeJournalEntry(entry.id)
    });
  }
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: onclose }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-lg memory-surface"
    role="dialog"
    aria-modal="true"
    aria-label={$t('roleplay.memory.title')}
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{$t('roleplay.memory.title')}</div>
        <div class="text-xs text-muted-foreground">
          {$t('roleplay.memory.subtitle', { values: { pinned: pinned.length, other: entries.length - pinned.length } })}
        </div>
      </div>
      <Tooltip label={copyText.actions.close} position="bottom"><UiIconButton label={copyText.actions.close} size="sm" type="button" class={uiClass("", "ui-local-bd484268")} onclick={onclose} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[60vh] space-y-5 overflow-y-auto">
      <section class="section">
        <div class="section-head">
          <h3 class="section-label min-w-0 flex-1">{$t('roleplay.journal.storySoFar')}</h3>
          <Button variant="plain"
            type="button"
            class={uiClass("tool", "ui-local-bd484268")}
            disabled={summarizing || appStore.currentChatGenerating}
            aria-label={$t('roleplay.journal.refreshSummary')}
            title={$t('roleplay.journal.refreshSummary')}
            onclick={() => appStore.currentChatId && void roleplayStore.summarize(appStore.currentChatId)}
          >
            {#if summarizing}<TileMeter mode="busy" />{:else}<RefreshCw class="size-3" />{/if}
          </Button>
        </div>
        <UiTextarea
          class={uiClass("summary-input", "ui-local-bd484268")}
          rows={3}
          value={summary}
          placeholder={$t('roleplay.journal.summaryEmpty')}
          aria-label={$t('roleplay.journal.storySoFar')}
          onchange={(event) => roleplayStore.setSummary(event.currentTarget.value)}
        ></UiTextarea>
      </section>

      <section class="section">
        <h3 class="section-label">
          <Pin class="size-3" />
          <span>{$t('roleplay.memory.pinned')}</span>
        </h3>
        {#if !pinned.length}
          <p class="empty">{$t('roleplay.memory.pinnedEmpty')}</p>
        {:else}
          <div class="entries">
            {#each pinned as entry (entry.id)}
              {@render memoryEntry(entry)}
            {/each}
          </div>
        {/if}
      </section>

      {#each grouped as section (section.kind)}
        <section class="section">
          <h3 class="section-label">{$t(`roleplay.journal.section.${section.kind}`)}</h3>
          <div class="entries">
            {#each section.entries as entry (entry.id)}
              {@render memoryEntry(entry)}
            {/each}
          </div>
        </section>
      {/each}

      {#if adding}
        <div class="composer">
          <div class="composer-row">
            {#each KINDS as kind (kind)}
              <Button variant="plain"
                type="button"
                class={uiClass(`kind-pill ${draftKind === kind ? 'is-on' : ''}`, "ui-local-bd484268")}
                aria-pressed={draftKind === kind}
                onclick={() => (draftKind = kind)}
              >
                {$t(`roleplay.journal.kind.${kind}`)}
              </Button>
            {/each}
          </div>
          <UiInput class={uiClass("", "ui-local-bd484268")} bind:value={draftTitle} placeholder={$t('roleplay.journal.titlePlaceholder')} />
          <UiTextarea class={uiClass(" min-h-20 resize-y", "ui-local-bd484268")} bind:value={draftBody} placeholder={$t('roleplay.journal.bodyPlaceholder')}></UiTextarea>
          <div class="composer-row composer-actions">
            <Button variant="outline" size="sm" type="button" onclick={() => (adding = false)}>{$t('roleplay.settings.cancel')}</Button>
            <Button variant="default" size="sm" type="button" onclick={add}>{$t('roleplay.journal.add')}</Button>
          </div>
        </div>
      {/if}
    </div>

    {#if !adding}
      <div class="memory-actions">
        <Button variant="outline" size="sm" type="button" onclick={() => (adding = true)}>
          <Plus class="size-3.5" />
          <span>{$t('roleplay.memory.add')}</span>
        </Button>
      </div>
    {/if}
  </div>
</div>

{#snippet memoryEntry(entry: RoleplayJournalEntry)}
  <article class="entry {entry.pinned ? 'is-pinned' : ''}">
    {#if editingId === entry.id}
      <div class="edit">
        <UiInput class={uiClass("", "ui-local-bd484268")} bind:value={editTitle} aria-label={$t('roleplay.journal.titlePlaceholder')} />
        <UiTextarea class={uiClass(" min-h-16 resize-y", "ui-local-bd484268")} bind:value={editBody} aria-label={$t('roleplay.journal.bodyPlaceholder')}></UiTextarea>
        <div class="composer-row composer-actions">
          <Button variant="outline" size="sm" type="button" onclick={() => (editingId = null)}>{$t('roleplay.settings.cancel')}</Button>
          <Button variant="default" size="sm" type="button" onclick={() => saveEdit(entry)}>{copyText.actions.save}</Button>
        </div>
      </div>
    {:else}
      <div class="entry-head">
        <span class="entry-title">{titleIsBody(entry) ? '' : shown(entry, entry.title)}</span>
        <span class="entry-tools">
          <Button variant="plain"
            type="button"
            class={uiClass("tool", "ui-local-bd484268")}
            aria-label={entry.pinned ? $t('roleplay.journal.unpin') : $t('roleplay.journal.pin')}
            title={entry.pinned ? $t('roleplay.journal.unpin') : $t('roleplay.journal.pin')}
            onclick={() => roleplayStore.pinJournalEntry(entry.id, !entry.pinned)}
          >
            {#if entry.pinned}<PinOff class="size-3" />{:else}<Pin class="size-3" />{/if}
          </Button>
          <UiIconButton label={$t('roleplay.memory.edit')} size="xs" variant="ghost" type="button" class={uiClass("tool", "ui-local-bd484268")}  title={$t('roleplay.memory.edit')} onclick={() => startEdit(entry)}>
            <Pencil class="size-3" />
          </UiIconButton>
          <UiIconButton label={$t('roleplay.journal.remove')} size="xs" variant="ghost" type="button" class={uiClass("tool hover:text-error", "ui-local-bd484268")}  title={$t('roleplay.journal.remove')} onclick={() => remove(entry)}>
            <Trash2 class="size-3" />
          </UiIconButton>
        </span>
      </div>
      {#if entry.body}
        <p class="entry-body">{shown(entry, entry.body)}</p>
      {/if}
    {/if}
  </article>
{/snippet}

<style>
  .memory-surface {
    width: min(32rem, calc(100vw - 2rem));
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  :global(.summary-input.ui-local-bd484268) {
    width: 100%;
    min-height: 4.5rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-hover);
    color: var(--foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
    resize: vertical;
  }

  .empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .entries {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .entry {
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-md);
    background: var(--surface-hover);
  }

  .entry.is-pinned {
    box-shadow: inset 2px 0 0 var(--text-muted);
  }

  .entry-head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .entry-title:empty {
    min-height: 1.5rem;
  }

  .entry-title {
    min-width: 0;
    flex: 1;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .entry-tools {
    display: flex;
    flex-shrink: 0;
    gap: 0.125rem;
  }

  .entry-body {
    margin: 0.25rem 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .edit {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  :global(.tool.ui-local-bd484268) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
  }

  :global(.tool:hover:not(:disabled).ui-local-bd484268) {
    background: var(--surface-active);
    color: var(--foreground);
  }

  :global(.tool:disabled.ui-local-bd484268) {
    opacity: 0.5;
    cursor: default;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem;
    border-radius: var(--radius-md);
    background: var(--surface-hover);
  }

  .composer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .composer-actions {
    justify-content: flex-end;
  }

  :global(.kind-pill.ui-local-bd484268) {
    padding: 0.2rem 0.6rem;
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  :global(.kind-pill:hover.ui-local-bd484268) {
    background: var(--surface-active);
    color: var(--foreground);
  }

  :global(.kind-pill.is-on.ui-local-bd484268) {
    background: var(--surface-active);
    color: var(--foreground);
    font-weight: 600;
  }

  .memory-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--border-subtle);
  }
</style>
