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
  import { AlertCircle, ArrowDown, CircleCheck, Copy, GitFork, History, RotateCcw, TriangleAlert } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import ReasoningBlock from '$lib/ui/components/ReasoningBlock.svelte';
  import CodeActivityGroup from './CodeActivityGroup.svelte';
  import { activityKind } from './activity';
  import { t } from 'svelte-i18n';
  import { copy, say } from '$lib/copy';
  import { formatDuration } from '$lib/utils/format';
  import { codeStore } from './code.svelte';
  import { orderedEntries } from './code-run';
  import TodoList from './TodoList.svelte';
  import SubagentGroup from './SubagentGroup.svelte';
  import PlanReviewCard from './PlanReviewCard.svelte';
  import { pendingPlan } from './plan-review';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { openWorkspaceFile } from '$lib/services/files';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));
  const plan = $derived(pendingPlan(messages));

  $effect(() => {
    void messages.length;
    void messages[messages.length - 1]?.content;
    void messages[messages.length - 1]?.agentSteps?.length;
    void run?.children.map((child) => `${child.status}${child.text}${child.summary}${child.tools.map((tool) => tool.output).join('')}`).join('');
    void run?.steps.map((step) => step.output).join('');
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

  async function messageAction(message: ChatMessage, action: 'copy' | 'fork' | 'rewind') {
    try {
      if (action === 'copy') await navigator.clipboard.writeText(message.content);
      else await codeStore.actOnMessage(chatId, message.id, action);
    } catch (error) { toastStore.error(String(error)); }
  }

  type Entry = ReturnType<typeof orderedEntries>[number];
  type Block = { key: string; steps?: NonNullable<Entry['step']>[]; text?: string };

  /** Consecutive steps become one block, so spacing separates text from work. */
  function groupEntries(entries: Entry[]): Block[] {
    const blocks: Block[] = [];
    for (const entry of entries) {
      const last = blocks[blocks.length - 1];
      if (entry.step) {
        if (last?.steps && activityKind(last.steps[0]!) === activityKind(entry.step)) last.steps.push(entry.step);
        else blocks.push({ key: entry.key, steps: [entry.step] });
      } else if (entry.text) {
        blocks.push({ key: entry.key, text: entry.text });
      }
    }
    return blocks;
  }

  function entriesFor(message: ChatMessage) {
    const live = message.status === 'streaming' && run?.assistantMessageId === message.id ? run.timeline : undefined;
    const children = live ? run?.children : message.metadata?.codeChildren;
    return orderedEntries(message, live).filter((entry) => !(children?.length && entry.step?.toolName === 'task' && entry.step.status !== 'error'));
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

<div bind:this={viewport} class="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-6" onscroll={onScroll}>
  <div class="mx-auto flex min-w-0 flex-col gap-5" style="max-width: var(--thread-width);">
    {#each messages as message (message.id)}
      {#if message.role === 'user'}
        <div class="group flex flex-col items-end gap-1">
          <div class="max-w-[85%] break-words whitespace-pre-wrap rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">
            {message.content}
            {#if message.metadata?.codeAttachments?.length}
              <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {#each message.metadata.codeAttachments as attachment, index (index)}<button type="button" class="max-w-64 truncate rounded-full bg-background/50 px-2 py-1 hover:bg-background" onclick={() => openWorkspaceFile(attachment.path).catch((error) => toastStore.error(String(error)))}>{attachment.name} · {attachment.kind}</button>{/each}
              </div>
            {/if}
          </div>
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />Copy</button>
            {#if message.metadata?.codeConversationIndex !== undefined && !run?.running}
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'fork')}><GitFork class="size-3" />Fork</button>
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'rewind')}><RotateCcw class="size-3" />Revert</button>
            {/if}
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
        {@const live = run?.assistantMessageId === message.id}
        {@const entries = entriesFor(message)}
        {@const todos = live ? run?.todos ?? [] : message.metadata?.codeTodos ?? []}
        {@const children = live ? run?.children ?? [] : message.metadata?.codeChildren ?? []}
        {@const diagnostics = live ? run?.diagnostics ?? [] : message.metadata?.codeDiagnostics ?? []}
        <div class="flex min-w-0 flex-col gap-4">
          {#if message.reasoning?.trim()}
            <ReasoningBlock reasoning={message.reasoning} status={message.status} variant="outline" />
          {/if}

          <!-- Runs of steps sit together as one block; text and cards get room around them. -->
          {#each groupEntries(entries) as block (block.key)}
            {#if block.steps}
              <div class="-mx-2 flex flex-col gap-px">
                <CodeActivityGroup steps={block.steps} {chatId} />
              </div>
            {:else if block.text}
              <div class="text-sm leading-relaxed text-foreground">
                <RichContent content={block.text} />
              </div>
            {/if}
          {/each}

          {#if children.length}<SubagentGroup {children} />{/if}
          {#if diagnostics.length}
            <details class="text-xs text-muted-foreground"><summary class="cursor-pointer">Runtime notes · {diagnostics.length}</summary><div class="mt-2 space-y-1">{#each diagnostics as note, index (index)}<p>{note}</p>{/each}</div></details>
          {/if}

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
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-warning">
                <TriangleAlert class="size-3" />
                {copy.codeRun.turnLimit}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'stop' && !entries.length && !message.reasoning?.trim()}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-warning">
                <TriangleAlert class="size-3" />
                {copy.codeRun.noReply}
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
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-warning">
                <TriangleAlert class="size-3" />
                {$t('code.statusLength')}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
    {#if plan && !run?.running}<PlanReviewCard {chatId} {plan} />{/if}
  </div>
  {#if !pinnedToBottom}
    <button type="button" class="sticky bottom-1 float-right flex items-center gap-1.5 rounded-full bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-sm" onclick={() => { pinnedToBottom = true; if (viewport) viewport.scrollTop = viewport.scrollHeight; }}><ArrowDown class="size-3.5" />Latest</button>
  {/if}
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
