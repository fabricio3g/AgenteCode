<svelte:options runes={true} />

<!--
  The queued prompts, above the composer they will be sent from.

  It reads as part of the composer, not as a dialog: the same card language
  (surface fill and a hairline ring), one quiet heading line, and rows that are
  the app's ordinary pill rows. The trailing actions only appear under the
  pointer, which keeps a queue of five messages from looking like five toolbars.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowUp, Paperclip, Pencil, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { QueuedPrompt } from '$lib/types/chat';

  let { items, onupdate, onremove, onsend }: {
    items: QueuedPrompt[];
    onupdate: (id: string, content: string) => void;
    onremove: (id: string) => void;
    onsend: () => void;
  } = $props();
  let editing = $state<string | null>(null);
  let draft = $state('');
  let editor = $state<HTMLTextAreaElement>();
  async function edit(item: QueuedPrompt) {
    draft = item.content; editing = item.id;
    await tick(); editor?.focus();
    editor?.setSelectionRange(draft.length, draft.length);
  }
  function sendNow() {
    if (editing) {
      if (!draft.trim()) return;
      save(editing);
    }
    onsend();
  }
  function save(id: string) {
    if (!draft.trim()) return;
    onupdate(id, draft); editing = null;
  }
</script>

<section class="prompt-queue" aria-label={$t('promptQueue.title')}>
  <div class="queue-heading">
    <span class="queue-title">{$t('promptQueue.title')} <span class="tabular-nums">{items.length}</span></span>
    <span class="queue-hint">{$t('promptQueue.hint')}</span>
    <button
      type="button"
      class="ui-chip queue-send"
      aria-label={$t('promptQueue.sendNow')}
      disabled={!items.some((item) => !item.sending) || (!!editing && !draft.trim())}
      onclick={sendNow}
    ><ArrowUp /><span>{$t('promptQueue.send')}</span></button>
  </div>
  <ol>
    {#each items as item, index (item.id)}
      <li class:is-sending={item.sending}>
        <span class="queue-number" aria-hidden="true">{index + 1}</span>
        {#if editing === item.id && !item.sending}
          <form onsubmit={(event) => { event.preventDefault(); save(item.id); }}>
            <textarea
              bind:this={editor}
              aria-label={$t('promptQueue.edit')}
              rows="2"
              bind:value={draft}
              onkeydown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); editing = null; }
                else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(item.id); }
              }}
            ></textarea>
            <div class="edit-actions">
              <button type="button" class="ui-chip" onclick={() => (editing = null)}>{$t('promptQueue.cancel')}</button>
              <button type="submit" class="ui-chip is-primary" disabled={!draft.trim()}>{$t('promptQueue.save')}</button>
            </div>
          </form>
        {:else}
          <span class="queue-text" title={item.content}>{item.content}</span>
          {#if (item.attachments?.length ?? item.codeAttachments?.length ?? 0) > 0}<span class="queue-paperclip" aria-hidden="true"><Paperclip /></span>{/if}
          {#if item.sending}
            <span class="queue-status">{$t('promptQueue.sending')}</span>
          {:else}
            <button type="button" class="ui-icon-button is-xs queue-action" aria-label={$t('promptQueue.edit')} onclick={() => void edit(item)}><Pencil /></button>
            <button type="button" class="ui-icon-button is-xs queue-action" aria-label={$t('promptQueue.remove')} onclick={() => onremove(item.id)}><X /></button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  /* The composer's own card language, one step quieter: same ring, same radius
     family, and no drop shadow competing with the input below it. */
  .prompt-queue {
    margin: 0 0.75rem 0.5rem;
    padding: 0.3rem 0.4rem 0.4rem;
    border-radius: var(--radius-xl);
    background: var(--composer-surface, var(--card));
    box-shadow: inset 0 0 0 1px var(--composer-ring, var(--border-subtle));
  }
  .queue-heading,
  li { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  .queue-heading { padding: 0 0.35rem 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .queue-title { font-weight: 500; color: var(--foreground); }
  .queue-hint { margin-left: auto; }
  .queue-send { margin-left: 0.25rem; }
  .queue-send:disabled { opacity: 0.45; cursor: default; }
  .queue-send:disabled:hover { border-color: var(--border); background: transparent; }

  ol { max-height: min(12rem, 30vh); overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  li {
    height: 1.75rem;
    border-radius: var(--radius-full);
    padding: 0 0.25rem 0 0.6rem;
    font-size: 12px;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  li:hover, li:focus-within { background: var(--surface-hover); }
  li:has(form) { height: auto; align-items: flex-start; padding: 0.35rem 0.4rem; }
  li.is-sending { color: var(--muted-foreground); }

  .queue-number { flex-shrink: 0; min-width: 0.75rem; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
  .queue-text { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
  li.is-sending .queue-text { color: var(--muted-foreground); }
  .queue-paperclip { display: inline-flex; flex-shrink: 0; color: var(--muted-foreground); }
  .queue-paperclip :global(svg) { width: 12px; height: 12px; }
  .queue-status { flex-shrink: 0; font-size: var(--text-xs); color: var(--muted-foreground); }

  /* Row actions follow the app's hover-reveal rule: present, never shouting. */
  .queue-action { opacity: 0; transition: opacity var(--motion-fast) var(--motion-ease); }
  li:hover .queue-action, li:focus-within .queue-action { opacity: 1; }

  form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.375rem; }
  .edit-actions { display: flex; justify-content: flex-end; gap: 0.375rem; }
  textarea {
    min-width: 0;
    width: 100%;
    max-height: 10rem;
    resize: vertical;
    padding: 0.4rem 0.5rem;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--foreground);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.5;
  }
  textarea:focus-visible { outline: 1px solid var(--border-hover); }

  @media (prefers-reduced-motion: reduce) {
    li, .queue-action { transition: none; }
  }
  @media (max-width: 600px) {
    .queue-hint { display: none; }
  }
</style>
