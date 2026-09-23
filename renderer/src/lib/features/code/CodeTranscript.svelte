<svelte:options runes={true} />

<!--
  The Code space transcript.

  The user speaks in a quiet right-aligned bubble; the agent answers
  full-width, in the order things happened: thinking (collapsible), then text
  and tool rows interleaved as the run produced them, then one footer with
  how it ended and how long it took. No avatars; hierarchy comes from
  alignment and type, not from icon boxes.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { AlertCircle, CircleCheck, History, TriangleAlert } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import ReasoningBlock from '$lib/ui/components/ReasoningBlock.svelte';
  import ToolCallRow from '$lib/components/agent/ToolCallRow.svelte';
  import { t } from 'svelte-i18n';
  import { copy, say } from '$lib/copy';
  import { formatDuration } from '$lib/utils/format';
  import { codeStore } from './code.svelte';
  import { orderedEntries } from './code-run';
  import TodoList from './TodoList.svelte';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));

  $effect(() => {
    void messages.length;
    void messages[messages.length - 1]?.content;
    void messages[messages.length - 1]?.agentSteps?.length;
    if (pinnedToBottom) {
      void tick().then(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
    }
  });

  function onScroll() {
    if (!viewport) return;
    pinnedToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }

  function entriesFor(message: ChatMessage) {
    const live = message.status === 'streaming' && run?.assistantMessageId === message.id ? run.timeline : undefined;
    return orderedEntries(message, live);
  }

  function noteText(note: string): string {
    if (note === 'interrupted') return copy.codeRun.interrupted;
    const restored = /^restore:(\d+)$/.exec(note);
    if (restored) {
      const count = Number(restored[1]);
      return count ? $t('code.restoredNote', { values: { files: say.files(count) } }) : $t('code.restoredNoteUnknown');
    }
    return note;
  }

  function elapsedLabel(message: ChatMessage): string {
    const ms = message.metadata?.codeElapsedMs;
    const time = ms ? formatDuration(ms / 1000) : '';
    return time ? $t('code.workedFor', { values: { time } }) : '';
  }
</script>

<div bind:this={viewport} class="flex-1 overflow-y-auto px-4 py-6" onscroll={onScroll}>
  <div class="mx-auto flex max-w-3xl flex-col gap-5">
    {#each messages as message (message.id)}
      {#if message.role === 'user'}
        <div class="flex justify-end">
          <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">
            {message.content}
          </div>
        </div>
      {:else if message.metadata?.codeNote && !message.content && !message.agentSteps?.length}
        <!-- A system note (restore, …): centered, quiet. -->
        <div class="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <History class="size-3" />
          <span>{noteText(message.metadata.codeNote)}</span>
        </div>
      {:else}
        {@const streaming = message.status === 'streaming'}
        {@const entries = entriesFor(message)}
        {@const todos = streaming ? run?.todos ?? [] : message.metadata?.codeTodos ?? []}
        <div class="flex flex-col gap-2">
          {#if message.reasoning}
            <ReasoningBlock reasoning={message.reasoning} status={message.status} variant="outline" />
          {/if}

          {#each entries as entry (entry.key)}
            {#if entry.step}
              <ToolCallRow step={entry.step} />
            {:else if entry.text}
              <div class="text-sm leading-relaxed text-foreground">
                <RichContent content={entry.text} />
              </div>
            {/if}
          {/each}

          {#if streaming && !entries.length && !message.reasoning}
            <div class="flex items-center px-1 text-xs text-muted-foreground">
              <span class="thinking-dots" aria-label={copy.status.working}></span>
            </div>
          {:else if streaming && entries[entries.length - 1]?.text}
            <span class="stream-caret" aria-hidden="true"></span>
          {/if}

          {#if todos.length}
            {#if streaming}
              <TodoList {todos} />
            {:else}
              <details class="plan-block">
                <summary class="cursor-pointer text-[11px] text-muted-foreground">
                  {copy.codeRun.plan} · {todos.filter((todo) => todo.status === 'completed').length}/{todos.length}
                </summary>
                <div class="mt-1.5"><TodoList {todos} /></div>
              </details>
            {/if}
          {/if}

          {#if streaming && run?.retrying}
            {@const retry = run.retrying}
            <div class="flex items-center gap-2 self-start rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
              <span class="retry-dot" aria-hidden="true"></span>
              {$t('code.retrying', { values: { n: retry.attempt } })}
            </div>
          {/if}

          {#if message.status === 'error'}
            {@const reason = message.metadata?.errorMessage || message.content || copy.tool.failed}
            <div class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
              <span class="min-w-0 break-words">{reason}</span>
            </div>
          {:else if message.done && !streaming}
            {@const reason = message.metadata?.codeStopReason}
            {@const elapsed = elapsedLabel(message)}
            {#if message.metadata?.codeNote}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-muted-foreground">
                <TriangleAlert class="size-3" />
                {noteText(message.metadata.codeNote)}
              </div>
            {:else if message.metadata?.codeHitTurnLimit}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-amber-600 dark:text-amber-400">
                <TriangleAlert class="size-3" />
                {copy.codeRun.turnLimit}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'stop'}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-muted-foreground">
                <CircleCheck class="size-3" />
                {$t('code.statusCompleted')}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'aborted'}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-muted-foreground">
                {$t('code.statusStopped')}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'length'}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-amber-600 dark:text-amber-400">
                <TriangleAlert class="size-3" />
                {$t('code.statusLength')}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .run-chip {
    opacity: 0.85;
  }

  .plan-block summary::marker {
    color: var(--muted-foreground);
  }

  /* Retry notice: a single breathing dot — presence without alarm. */
  .retry-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 9999px;
    background: var(--muted-foreground);
    animation: code-retry-pulse 1s ease-in-out infinite;
  }
  @keyframes code-retry-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }

  /* Streaming caret: a breathing block under the live text. */
  .stream-caret {
    display: inline-block;
    width: 0.5rem;
    height: 1em;
    margin-left: 0.15rem;
    border-radius: 1px;
    background: var(--foreground);
    opacity: 0.75;
    animation: code-caret-breathe 1s ease-in-out infinite;
  }

  @keyframes code-caret-breathe {
    0%, 100% { opacity: 0.15; }
    50% { opacity: 0.8; }
  }

  .thinking-dots {
    position: relative;
    width: 2rem;
    height: 1.25rem;
  }
  .thinking-dots::before,
  .thinking-dots::after {
    content: '';
    position: absolute;
    top: 0.4rem;
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 9999px;
    background: var(--muted-foreground);
    animation: code-pulse 1.2s ease-in-out infinite;
  }
  .thinking-dots::before {
    left: 0.25rem;
  }
  .thinking-dots::after {
    left: 0.85rem;
    animation-delay: 0.2s;
  }
  @keyframes code-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .stream-caret,
    .retry-dot,
    .thinking-dots::before,
    .thinking-dots::after {
      animation: none;
    }
  }
</style>
