<svelte:options runes={true} />

<!--
  What waits for the agent, in its own panel above the composer: steers it
  has been handed but not read yet ("Next step") and prompts held for when
  the run ends ("After run"). A message joins the transcript only when the
  agent reads it, so the thread never shows a prompt it has not seen.

  Rows are the app's ordinary pill rows; their actions only appear under the
  pointer. A steer already handed over can no longer change, so it has none.
-->

<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { tick } from 'svelte';
  import { ArrowUp, CornerDownRight, MessageSquareShare, Paperclip, Pencil, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { QueuedPrompt } from '$lib/types/chat';

  let { items, running = false, steers = false, onupdate, onremove, onsend }: {
    items: QueuedPrompt[];
    /** A run is working: held prompts wait for it. */
    running?: boolean;
    /** "Now" hands the prompt to the running turn (Code) instead of interrupting it (Home). */
    steers?: boolean;
    onupdate: (id: string, content: string) => void;
    onremove: (id: string) => void;
    /** Hand one prompt to the agent now, or every held one without an id. */
    onsend: (id?: string) => void;
  } = $props();
  /** Prompts still held (not yet handed to the agent). */
  const held = $derived(items.filter((item) => !item.sending));
  const nowLabel = $derived(running && steers ? $t('promptQueue.steerNow') : $t('promptQueue.send'));
  let editing = $state<string | null>(null);
  let draft = $state('');
  let editor = $state<HTMLTextAreaElement>();
  async function edit(item: QueuedPrompt) {
    draft = item.content; editing = item.id;
    await tick(); editor?.focus();
    editor?.setSelectionRange(draft.length, draft.length);
  }
  function save(id: string) {
    if (!draft.trim()) return;
    onupdate(id, draft); editing = null;
  }
</script>

<section class="prompt-queue" aria-label={$t('promptQueue.title')} data-prompt-queue>
  <div class="queue-heading">
    <MessageSquareShare class="queue-icon" aria-hidden="true" />
    <span class="queue-title">{$t('promptQueue.title')}</span>
    <span class="queue-count tabular-nums">{items.length}</span>
    <!-- Only where a run takes several at once: Home sends one prompt per turn. -->
    {#if running && steers && held.length > 1}
      <Button variant="plain" type="button" class={uiClass("queue-all", "ui-local-7f791877")} onclick={() => onsend()}><ArrowUp aria-hidden="true" />{$t('promptQueue.steerAll')}</Button>
    {/if}
  </div>
  <ol>
    {#each items as item (item.id)}
      <li class:is-next={item.sending}>
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
          {#if item.sending}
            <span class="queue-kind is-next"><CornerDownRight aria-hidden="true" />{$t('promptQueue.nextStep')}</span>
          {:else if running}
            <span class="queue-kind">{$t('promptQueue.afterRun')}</span>
          {/if}
          <span class="queue-text" title={item.content}>{item.content}</span>
          {#if (item.attachments?.length ?? item.codeAttachments?.length ?? 0) > 0}<span class="queue-paperclip" aria-hidden="true"><Paperclip /></span>{/if}
          {#if !item.sending}
            <Tooltip label={$t('promptQueue.edit')} position="top"><UiIconButton label={$t('promptQueue.edit')} size="xs" type="button" class={uiClass("  queue-action", "ui-local-7f791877")}  onclick={() => void edit(item)}><Pencil /></UiIconButton></Tooltip>
            <Tooltip label={$t('promptQueue.remove')} position="top"><UiIconButton label={$t('promptQueue.remove')} size="xs" type="button" class={uiClass("  queue-action", "ui-local-7f791877")}  onclick={() => onremove(item.id)}><X /></UiIconButton></Tooltip>
            <!-- Always on screen: the one action every held row is for. -->
            <Button variant="plain" type="button" class={uiClass("queue-now", "ui-local-7f791877")} onclick={() => onsend(item.id)}><ArrowUp aria-hidden="true" />{nowLabel}</Button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  /* Its own panel above the composer, not a tab on it: the task list lives
     in the thread, so this card only says what waits. */
  .prompt-queue {
    margin: 0 0.75rem 0.5rem;
    padding: 0.375rem 0.375rem 0.375rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--card);
  }
  .queue-heading,
  li { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  .queue-heading { min-height: 1.625rem; padding: 0 0.125rem 0.25rem 0.375rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .queue-heading :global(.queue-icon) { width: 0.875rem; height: 0.875rem; flex-shrink: 0; color: var(--brand-accent); }
  .queue-title { font-weight: 500; color: var(--foreground); }
  .queue-count {
    min-width: 1.125rem;
    padding: 0 0.3125rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    text-align: center;
  }

  ol { display: flex; flex-direction: column; gap: 0.125rem; max-height: min(12rem, 30vh); overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  li {
    min-height: 2rem;
    border-radius: var(--radius-md);
    padding: 0.125rem 0.25rem 0.125rem 0.375rem;
    font-size: var(--text-sm);
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  li:hover, li:focus-within { background: var(--surface-hover); }
  /* The step the agent reads next: a quiet ember wash, so the two lanes part at a glance. */
  li.is-next { background: color-mix(in srgb, var(--brand-accent) 7%, transparent); }
  li:has(form) { height: auto; align-items: flex-start; padding: 0.35rem 0.4rem; }

  /* Which lane a row is in: the ember arrow is the one the agent reads next. */
  .queue-kind {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.4375rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .queue-kind.is-next { background: transparent; padding-inline-start: 0; color: var(--brand-accent); }
  .queue-kind :global(svg) { width: 0.75rem; height: 0.75rem; }
  .queue-text { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
  .queue-paperclip { display: inline-flex; flex-shrink: 0; color: var(--muted-foreground); }
  .queue-paperclip :global(svg) { width: 12px; height: 12px; }

  /* Steer one / steer all: small pills, present without hover. */
  :global(:is(.queue-now, .queue-all).ui-local-7f791877) {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    height: 1.5rem;
    padding: 0 0.5rem 0 0.4375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease);
  }
  :global(:is(.queue-now, .queue-all).ui-local-7f791877:hover) { border-color: var(--brand-accent); }
  :global(:is(.queue-now, .queue-all).ui-local-7f791877) :global(svg) { width: 0.75rem; height: 0.75rem; color: var(--brand-accent); }
  :global(.queue-all.ui-local-7f791877) { margin-inline-start: auto; }

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
</style>
