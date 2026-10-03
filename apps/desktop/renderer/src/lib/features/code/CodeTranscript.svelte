<svelte:options runes={true} />

<!--
  The Code space transcript.

  The user speaks in a quiet right-aligned bubble; the agent answers
  full-width, strictly in the order things happened: text, and between the
  words one work block of thoughts and tool calls (see work-blocks.ts). A
  live reply ends with one status line — what is happening right now — so
  the newest thing always sits next to the composer; a finished one ends
  with how it ended and how long it took. The task list lives on the
  composer, the presented plan in the right dock.
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { ArrowDown, CircleCheck, ClipboardList, Clock, Copy, GitFork, History, RotateCcw, TriangleAlert } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import MediaAttachmentCard from './MediaAttachmentCard.svelte';
  import CodeWorkBlock from './CodeWorkBlock.svelte';
  import CodeLiveStatus from './CodeLiveStatus.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import { withoutCodeErrorText } from './code-error';
  import { t } from 'svelte-i18n';
  import { copy, say } from '$lib/copy';
  import { formatDuration } from '$lib/utils/format';
  import { codeStore } from './code.svelte';
  import { orderedEntries } from './code-run';
  import SubagentGroup from './SubagentGroup.svelte';
  import { pendingPlan } from './plan-review';
  import { codeWorkspace } from './workspace.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { editedFiles, replyBlocks } from './work-blocks';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));
  const plan = $derived(pendingPlan(messages));

  // A plan waiting for an answer opens in the right dock, beside the conversation.
  $effect(() => {
    if (plan && !run?.running) codeWorkspace.offerPlan(chatId, plan);
  });

  // Hand the Changes pane what this conversation edited, for files git can't show.
  $effect(() => {
    codeWorkspace.setTranscriptEdits(chatId, editedFiles(messages.flatMap((message) => message.agentSteps ?? [])));
  });

  let scrollFrame = 0;
  onDestroy(() => { if (scrollFrame) cancelAnimationFrame(scrollFrame); });
  $effect(() => {
    void messages.length;
    void messages[messages.length - 1]?.content;
    void messages[messages.length - 1]?.agentSteps?.length;
    for (const child of run?.children ?? []) {
      void child.status; void child.text.length; void child.summary?.length;
      for (const tool of child.tools) void tool.output?.length;
    }
    for (const step of run?.steps ?? []) void step.output?.length;
    void run?.timeline.length;
    void run?.preparing;
    if (pinnedToBottom && !scrollFrame) {
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (viewport && pinnedToBottom) viewport.scrollTop = viewport.scrollHeight;
      });
    }
  });

  function onScroll() {
    if (!viewport) return;
    pinnedToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }

  async function messageAction(message: ChatMessage, action: 'copy' | 'fork' | 'rewind') {
    try {
      if (action === 'copy') {
        if (!await writeToClipboard(message.content)) throw new Error('Could not copy the message');
        toastStore.success($t('chat.copied'));
      }
      else await codeStore.actOnMessage(chatId, message.id, action);
    } catch (error) { toastStore.error(String(error)); }
  }

  function entriesFor(message: ChatMessage) {
    const live = message.status === 'streaming' && run?.assistantMessageId === message.id ? run.timeline : undefined;
    const children = live ? run?.children : message.metadata?.codeChildren;
    return withoutCodeErrorText(orderedEntries(message, live), diagnosticFor(message))
      .filter((entry) => showEntry(entry, Boolean(children?.length)));
  }

  function diagnosticFor(message: ChatMessage): string | undefined {
    if (message.status !== 'error') return undefined;
    return message.metadata?.errorMessage || message.content;
  }

  function showEntry(entry: ReturnType<typeof orderedEntries>[number], hasChildren: boolean): boolean {
    return !(hasChildren && entry.step?.toolName === 'task' && entry.step.status !== 'error');
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

<!-- The bottom padding clears the composer dock's 3rem fade, so the last line
     rests fully visible when scrolled to the end; text only fades while it
     scrolls past. -->
<div bind:this={viewport} class="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-16 pt-6" onscroll={onScroll}>
  <div class="mx-auto flex min-w-0 flex-col gap-3" style="max-width: var(--thread-width);">
    {#each messages as message (message.id)}
      <div class="code-message-slot" class:is-live={message.status === 'streaming'}>
      {#if message.role === 'user'}
        {@const queued = !!message.metadata?.codeQueued && !!run?.running}
        <div class="group flex flex-col items-end gap-1">
          <div class="max-w-[85%] break-words whitespace-pre-wrap rounded-3xl bg-muted px-5 py-2.5 text-sm leading-relaxed text-foreground" class:opacity-60={queued}>
            {message.content}
            {#if message.metadata?.codeAttachments?.length}
              <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {#each message.metadata.codeAttachments as attachment (attachment.path)}<MediaAttachmentCard {attachment} />{/each}
              </div>
            {/if}
          </div>
          {#if queued}<span class="flex items-center gap-1 text-xs text-muted-foreground"><Clock class="size-3" />{$t('code.message.queued')}</span>{/if}
          <div class="flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />{$t('code.message.copy')}</button>
            {#if message.metadata?.codeConversationIndex !== undefined && !run?.running}
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'fork')}><GitFork class="size-3" />{$t('code.message.fork')}</button>
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'rewind')}><RotateCcw class="size-3" />{$t('code.message.revert')}</button>
            {/if}
          </div>
        </div>
      {:else if message.metadata?.codeCompaction}
        {@const report = message.metadata.codeCompaction}
        <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <ClipboardList class="size-3" />
          <span>{report.running ? copy.codeRun.compacting : report.success ? (report.tokensBefore === report.tokensAfter ? $t('code.compaction.unchanged') : copy.codeRun.compacted) : $t('code.compaction.failed')}</span>
          {#if report.tokensBefore !== undefined && report.tokensAfter !== undefined}
            <span class="tabular-nums">· ~{report.tokensBefore.toLocaleString()} → ~{report.tokensAfter.toLocaleString()} {$t('code.compaction.tokens')}</span>
            <span>· {report.smart ? $t('code.compaction.summarized') : report.requestedSmart ? $t('code.compaction.fallback') : $t('code.compaction.noModelCall')}</span>
            {#if report.cacheReadTokens}<span>· {$t('code.compaction.cached', { values: { n: report.cacheReadTokens.toLocaleString() } })}</span>{/if}
            {#if report.requestedSmart}<span>· {report.modelTokens !== undefined ? $t('code.compaction.spent', { values: { n: report.modelTokens.toLocaleString() } }) : $t('code.compaction.unreported')}</span>{/if}
          {/if}
        </div>
      {:else if message.metadata?.codeNote && !message.content && !message.agentSteps?.length}
        <!-- A system note (restore, …): centered, quiet. -->
        <div class="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <History class="size-3" />
          <span>{noteText(message.metadata.codeNote)}</span>
        </div>
      {:else}
        {@const streaming = message.status === 'streaming'}
        {@const live = run?.assistantMessageId === message.id}
        {@const entries = entriesFor(message)}
        {@const children = live ? run?.children ?? [] : message.metadata?.codeChildren ?? []}
        {@const diagnostics = live ? run?.diagnostics ?? [] : message.metadata?.codeDiagnostics ?? []}
        {@const blocks = replyBlocks(entries)}
        <div class="group flex min-w-0 flex-col gap-3">
          {#each blocks as block, index (block.key)}
            {#if block.items}
              <div class="-mx-2 min-w-0">
                <CodeWorkBlock items={block.items} {chatId} live={streaming && index === blocks.length - 1} />
              </div>
            {:else}
              <div class="text-sm leading-relaxed text-foreground">
                <RichContent content={block.text} status={streaming && index === blocks.length - 1 ? 'streaming' : 'idle'} />
              </div>
            {/if}
          {/each}

          {#if children.length}<SubagentGroup {children} />{/if}
          {#if diagnostics.length}
            <details class="text-xs text-muted-foreground"><summary class="cursor-pointer">{$t('code.runtimeNotes', { values: { n: diagnostics.length } })}</summary><div class="mt-2 space-y-1">{#each diagnostics as note, index (index)}<p>{note}</p>{/each}</div></details>
          {/if}

          <!-- What is happening now: always the last line, next to the composer. -->
          {#if streaming && live && run}
            <div class="-mx-2"><CodeLiveStatus {run} awaitingApproval={approvalsStore.forChat(chatId).length > 0} /></div>
          {/if}

          {#if message.status === 'error'}
            {@const reason = message.metadata?.errorMessage || message.content || copy.tool.failed}
            <CodeErrorNotice detail={reason} />
          {:else if message.done && !streaming}
            {@const reason = message.metadata?.codeStopReason}
            {@const elapsed = elapsedLabel(message)}
            {#if message.metadata?.codeNote}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-muted-foreground">
                <TriangleAlert class="size-3" />
                {noteText(message.metadata.codeNote)}
              </div>
            {:else if message.metadata?.codeHitTurnLimit}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-warning">
                <TriangleAlert class="size-3" />
                {copy.codeRun.turnLimit}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'stop' && !entries.length && !message.reasoning?.trim()}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-warning">
                <TriangleAlert class="size-3" />
                {copy.codeRun.noReply}
              </div>
            {:else if reason === 'stop'}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-muted-foreground">
                <CircleCheck class="size-3" />
                {$t('code.statusCompleted')}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'aborted'}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-muted-foreground">
                {$t('code.statusStopped')}{elapsed ? ` · ${elapsed}` : ''}
              </div>
            {:else if reason === 'length'}
              <div class="run-chip flex items-center gap-1.5 self-start text-xs text-warning">
                <TriangleAlert class="size-3" />
                {$t('code.statusLength')}
              </div>
            {/if}
          {/if}
          {#if message.content.trim()}<button type="button" class="flex items-center gap-1 self-start text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100" onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />{$t('code.message.copy')}</button>{/if}
        </div>
      {/if}
      </div>
    {/each}
    {#if plan && !run?.running && codeWorkspace.plan?.chatId !== chatId}
      <button type="button" class="plan-reopen self-start" onclick={() => codeWorkspace.showPlan(chatId, plan)}>
        <ClipboardList class="size-3.5" />
        <span class="truncate">{plan.title}</span>
        <span class="text-muted-foreground">· {$t('code.plan.open')}</span>
      </button>
    {/if}
  </div>
  {#if !pinnedToBottom}
    <!-- Back to the latest output: centred, above the composer, never over text. -->
    <div class="pointer-events-none sticky bottom-2 flex justify-center">
      <button
        type="button"
        class="jump-latest pointer-events-auto"
        aria-label={$t('chat.jumpToLatest')}
        title={$t('chat.jumpToLatest')}
        onclick={() => { pinnedToBottom = true; if (viewport) viewport.scrollTop = viewport.scrollHeight; }}
      ><ArrowDown class="size-4" /></button>
    </div>
  {/if}
</div>

<style>
  .run-chip {
    opacity: 0.85;
  }

  .plan-reopen {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--border-subtle);
    font-size: 13px;
    color: var(--foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .plan-reopen:hover {
    background: var(--surface-hover);
  }

  .jump-latest {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--popover);
    color: var(--muted-foreground);
    box-shadow: var(--shadow-lg);
  }
  .jump-latest:hover { color: var(--foreground); }

  .code-message-slot { min-width: 0; content-visibility: auto; contain-intrinsic-size: auto 120px; }
  .code-message-slot.is-live { content-visibility: visible; }
</style>
