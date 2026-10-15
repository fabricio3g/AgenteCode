<svelte:options runes={true} />

<!--
  The queued prompts, above the composer they will be sent from.

  It reads as part of the composer, not as a dialog: the same card language
  (surface fill and a hairline ring), one quiet heading line, and rows that are
  the app's ordinary pill rows. The trailing actions only appear under the
  pointer, which keeps a queue of five messages from looking like five toolbars.
-->

<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { tick } from 'svelte';
  import { ArrowUp, Paperclip, Pencil, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { QueuedPrompt } from '$lib/types/chat';

  let { items, onupdate, onremove, onsend, canSendAll = true }: {
    items: QueuedPrompt[];
    onupdate: (id: string, content: string) => void;
    onremove: (id: string) => void;
    /** One prompt by id, or every waiting prompt when called without one. */
    onsend: (id?: string) => void;
    /** Some runtimes send one prompt per turn; they only offer "send one". */
    canSendAll?: boolean;
  } = $props();
  const waiting = $derived(items.filter((item) => !item.sending));
  let editing = $state<string | null>(null);
  let draft = $state('');
  let editor = $state<HTMLTextAreaElement>();
  async function edit(item: QueuedPrompt) {
    draft = item.content; editing = item.id;
    await tick(); editor?.focus();
    editor?.setSelectionRange(draft.length, draft.length);
  }
  function sendNow(id?: string) {
    if (editing) {
      if (!draft.trim()) return;
      save(editing);
    }
    onsend(id);
  }
  function save(id: string) {
    if (!draft.trim()) return;
    onupdate(id, draft); editing = null;
  }
</script>

<section class="prompt-queue" aria-label={$t('promptQueue.title')}>
  <div class="queue-heading">
    <span class="queue-title">{$t('promptQueue.title')} <span class="tabular-nums">{items.length}</span></span>
    <Button variant="outline" size="sm" class="ml-auto"
      type="button"
      title={$t('promptQueue.hint')}
      aria-label={$t('promptQueue.sendNow')}
      disabled={!waiting.length || (!!editing && !draft.trim())}
      onclick={() => sendNow(waiting.length > 1 && !canSendAll ? waiting[0]!.id : undefined)}
    ><ArrowUp /><span>{waiting.length > 1 ? (canSendAll ? $t('promptQueue.sendAll') : $t('promptQueue.sendNext')) : $t('promptQueue.send')}</span></Button>
  </div>
  <ol>
    {#each items as item, index (item.id)}
      <li class:is-sending={item.sending}>
        <span class="queue-number" aria-hidden="true">{index + 1}</span>
        {#if editing === item.id && !item.sending}
          <form onsubmit={(event) => { event.preventDefault(); save(item.id); }}>
            <UiTextarea class={uiClass('', "ui-local-7f791877")}
              bind:ref={editor}
              aria-label={$t('promptQueue.edit')}
              rows={2}
              bind:value={draft}
              onkeydown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); editing = null; }
                else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(item.id); }
              }}
            ></UiTextarea>
            <div class="edit-actions">
              <Button variant="outline" size="sm" type="button" onclick={() => (editing = null)}>{$t('promptQueue.cancel')}</Button>
              <Button variant="default" size="sm" type="submit" disabled={!draft.trim()}>{$t('promptQueue.save')}</Button>
            </div>
          </form>
        {:else}
          <span class="queue-text" title={item.content}>{item.content}</span>
          {#if (item.attachments?.length ?? item.codeAttachments?.length ?? 0) > 0}<span class="queue-paperclip" aria-hidden="true"><Paperclip /></span>{/if}
          {#if item.sending}
            <span class="queue-status">{$t('promptQueue.sending')}</span>
          {:else}
            {#if waiting.length > 1}<Tooltip label={$t('promptQueue.sendOne')} position="top"><UiIconButton label={$t('promptQueue.sendOne')} size="xs" type="button" class={uiClass("  queue-action", "ui-local-7f791877")}  onclick={() => sendNow(item.id)}><ArrowUp /></UiIconButton></Tooltip>{/if}
            <Tooltip label={$t('promptQueue.edit')} position="top"><UiIconButton label={$t('promptQueue.edit')} size="xs" type="button" class={uiClass("  queue-action", "ui-local-7f791877")}  onclick={() => void edit(item)}><Pencil /></UiIconButton></Tooltip>
            <Tooltip label={$t('promptQueue.remove')} position="top"><UiIconButton label={$t('promptQueue.remove')} size="xs" type="button" class={uiClass("  queue-action", "ui-local-7f791877")}  onclick={() => onremove(item.id)}><X /></UiIconButton></Tooltip>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  /* A dock like the todo bar: sits on the composer's top edge, same inset,
     fill and hairline, rounded on top only. */
  .prompt-queue {
    margin: 0 0.75rem -1px;
    padding: 0.3rem 0.4rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-bottom: 0;
    border-radius: 0.75rem 0.75rem 0 0;
    background: color-mix(in srgb, var(--muted) 55%, var(--chat-bg, var(--background)));
  }
  .queue-heading,
  li { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  .queue-heading { padding: 0 0.35rem 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .queue-title { font-weight: 500; color: var(--foreground); }

  ol { max-height: min(12rem, 30vh); overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  li {
    height: 1.75rem;
    border-radius: var(--radius-full);
    padding: 0 0.25rem 0 0.6rem;
    font-size: var(--text-xs);
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
  :global(.queue-action.ui-local-7f791877) { opacity: 0; transition: opacity var(--motion-fast) var(--motion-ease); }
  li:hover :global(.queue-action.ui-local-7f791877), li:focus-within :global(.queue-action.ui-local-7f791877) { opacity: 1; }

  form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.375rem; }
  .edit-actions { display: flex; justify-content: flex-end; gap: 0.375rem; }
  :global(textarea.ui-local-7f791877) {
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
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  :global(textarea:focus-visible.ui-local-7f791877) { outline: 1px solid var(--border-hover); }

  @media (prefers-reduced-motion: reduce) {
    li, :global(.queue-action.ui-local-7f791877) { transition: none; }
  }
  @media (max-width: 600px) {
  }
</style>
