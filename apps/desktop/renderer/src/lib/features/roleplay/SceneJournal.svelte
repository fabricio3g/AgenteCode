<svelte:options runes={true} />

<!--
  Scene journal: the campaign book for one scene.

  Handouts arrive from props the replies handed over; notes, leads and bonds are
  yours. Grouped by kind and pinned to the top when they matter. Everything is
  stored on the chat's roleplay state, so the journal travels with the scene.
-->

<script lang="ts">
  import { BookMarked, LoaderCircle, Pin, Plus, RefreshCw, Trash2, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { flyAndScale, motionFade } from '$lib/utils/transitions';
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

  const SECTIONS: Array<{ kind: RoleplayJournalEntry['kind']; label: string }> = [
    { kind: 'prop', label: 'Handouts' },
    { kind: 'quest', label: 'Leads' },
    { kind: 'bond', label: 'Bonds' },
    { kind: 'note', label: 'Notes' }
  ];

  const entries = $derived(appStore.currentChat?.roleplay?.journal ?? []);
  const summary = $derived(appStore.currentChat?.roleplay?.storySummary?.text ?? '');
  const summarizing = $derived(!!roleplayStore.summarizing[appStore.currentChatId || '']);

  const grouped = $derived(
    SECTIONS.map((section) => ({
      ...section,
      entries: entries
        .filter((entry) => entry.kind === section.kind)
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt)
    })).filter((section) => section.entries.length > 0)
  );

  let adding = $state(false);
  let draftKind = $state<RoleplayJournalEntry['kind']>('note');
  let draftTitle = $state('');
  let draftBody = $state('');

  function add() {
    const title = draftTitle.trim();
    const body = draftBody.trim();
    if (!title && !body) return;
    roleplayStore.addJournalEntry({ kind: draftKind, title: title || 'Untitled', body });
    draftTitle = '';
    draftBody = '';
    adding = false;
  }

  function remove(entry: RoleplayJournalEntry) {
    confirmStore.show({
      title: 'Remove from journal?',
      message: `"${entry.title}" will be gone from this scene.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => roleplayStore.removeJournalEntry(entry.id)
    });
  }
</script>

<div
  class="aui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: onclose }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="aui-modal-surface max-w-lg journal-surface"
    role="dialog"
    aria-modal="true"
    aria-label="Scene journal"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="aui-modal-header">
      <div class="min-w-0">
        <div class="aui-modal-title">Scene journal</div>
        <div class="text-xs text-muted-foreground">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </div>
      </div>
      <button type="button" class="aui-icon-button" onclick={onclose} aria-label={copyText.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="aui-modal-body max-h-[58vh] space-y-4 overflow-y-auto">
      <section class="section">
        <div class="flex items-center gap-2">
          <h3 class="section-label min-w-0 flex-1">{$t('roleplay.journal.storySoFar')}</h3>
          <button
            type="button"
            class="tool"
            disabled={summarizing || appStore.currentChatGenerating}
            aria-label={$t('roleplay.journal.refreshSummary')}
            title={$t('roleplay.journal.refreshSummary')}
            onclick={() => appStore.currentChatId && void roleplayStore.summarize(appStore.currentChatId)}
          >
            {#if summarizing}<LoaderCircle class="size-3 animate-spin" />{:else}<RefreshCw class="size-3" />{/if}
          </button>
        </div>
        <textarea
          class="summary-input"
          rows="4"
          value={summary}
          placeholder={$t('roleplay.journal.summaryEmpty')}
          aria-label={$t('roleplay.journal.storySoFar')}
          onchange={(event) => roleplayStore.setSummary(event.currentTarget.value)}
        ></textarea>
      </section>

      {#if !grouped.length && !adding}
        <p class="empty">
          Nothing kept yet. Props the scene hands over land here, and you can pin your own notes.
        </p>
      {/if}

      {#each grouped as section (section.kind)}
        <section class="section">
          <h3 class="section-label">{section.label}</h3>
          <div class="entries">
            {#each section.entries as entry (entry.id)}
              <article class="entry {entry.pinned ? 'is-pinned' : ''}">
                <div class="entry-head">
                  <span class="entry-title">{entry.title}</span>
                  <span class="entry-tools">
                    <button
                      type="button"
                      class="tool"
                      aria-label={entry.pinned ? 'Unpin' : 'Pin to the top'}
                      onclick={() => roleplayStore.pinJournalEntry(entry.id, !entry.pinned)}
                    >
                      <Pin class="size-3" />
                    </button>
                    <button type="button" class="tool" aria-label="Remove" onclick={() => remove(entry)}>
                      <Trash2 class="size-3" />
                    </button>
                  </span>
                </div>
                {#if entry.body}
                  <p class="entry-body">{entry.body}</p>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/each}

      {#if adding}
        <div class="composer">
          <div class="composer-row">
            {#each SECTIONS as section (section.kind)}
              <button
                type="button"
                class="kind-pill {draftKind === section.kind ? 'is-on' : ''}"
                onclick={() => (draftKind = section.kind)}
              >
                {section.label.replace(/s$/, '')}
              </button>
            {/each}
          </div>
          <input class="aui-input" bind:value={draftTitle} placeholder="What it is" />
          <textarea class="aui-input min-h-20 resize-y" bind:value={draftBody} placeholder="What it says, or what it means"></textarea>
          <div class="composer-row composer-actions">
            <button type="button" class="aui-btn aui-btn-ghost" onclick={() => (adding = false)}>Cancel</button>
            <button type="button" class="aui-btn aui-btn-primary" onclick={add}>Add</button>
          </div>
        </div>
      {/if}
    </div>

    {#if !adding}
      <div class="journal-actions">
        <button type="button" class="aui-btn aui-btn-ghost" onclick={() => (adding = true)}>
          <Plus class="size-3.5" />
          <span>Add to journal</span>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .summary-input {
    width: 100%;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    padding: 0.45rem 0.6rem;
    color: var(--foreground);
    font-size: 13px;
    line-height: 1.5;
  }

  .summary-input:focus {
    outline: none;
    border-color: var(--border-hover);
  }

  .journal-surface {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .empty {
    color: var(--text-tertiary);
    font-size: 0.8125rem;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .section-label {
    color: var(--text-tertiary);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .entries {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .entry {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    background: var(--card);
  }

  .entry.is-pinned {
    border-color: var(--border-hover);
  }

  .entry-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }

  .entry-title {
    min-width: 0;
    font-size: 0.8125rem;
    font-weight: 550;
  }

  .entry-tools {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .entry:hover .entry-tools,
  .entry:focus-within .entry-tools {
    opacity: 1;
  }

  .tool {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 0;
    border-radius: var(--radius-input);
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .tool:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .entry-body {
    margin-top: 0.25rem;
    color: var(--text-secondary);
    font-family: var(--font-serif);
    font-size: 0.8125rem;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .composer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .composer-actions {
    justify-content: flex-end;
  }

  .kind-pill {
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--text-muted);
    font-size: 0.6875rem;
    cursor: pointer;
  }

  .kind-pill:hover {
    border-color: var(--border-hover);
  }

  .kind-pill.is-on {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .journal-actions {
    display: flex;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-subtle);
  }

  .journal-actions :global(.aui-btn) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
