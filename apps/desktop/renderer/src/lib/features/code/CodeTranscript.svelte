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
  import CompactionReport from './CompactionReport.svelte';
  import { onDestroy } from 'svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { CircleCheck, ClipboardList, Clock, Copy, GitFork, History, RotateCcw, TriangleAlert } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import DeferredMessage from '$lib/features/shared/DeferredMessage.svelte';
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
  import JumpToLatest from '$lib/features/chat/thread/JumpToLatest.svelte';
  import { runMeterMode } from './tile-meter';
  import { pendingPlan } from './plan-review';
  import { codeWorkspace } from './workspace.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { editedFiles, replyBlocks } from './work-blocks';
  import { unlinkedChildren } from './subagent-row';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));
  const plan = $derived(pendingPlan(messages));

  /* An approval waiting on you is the one thing a scrolled-away transcript
     cannot show, so the status row and the jump button share the answer. */
  const awaitingApproval = $derived(approvalsStore.forChat(chatId).length > 0);

  /* The button's meter reads the same clock as the status row, and only ticks
     while a run is live: an idle transcript must not wake twice a second. */
  let meterNow = $state(Date.now());
  const jumpMode = $derived(run?.running ? runMeterMode(run, awaitingApproval, meterNow) : 'quiet');
  $effect(() => {
    if (!run?.running) return;
    meterNow = Date.now();
    const timer = setInterval(() => (meterNow = Date.now()), 500);
    return () => clearInterval(timer);
  });

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

  function followContentGrowth(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom || scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (viewport && pinnedToBottom) viewport.scrollTop = viewport.scrollHeight;
      });
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

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
    return withoutCodeErrorText(orderedEntries(message, live), diagnosticFor(message));
  }

  function diagnosticFor(message: ChatMessage): string | undefined {
    if (message.status !== 'error') return undefined;
    return message.metadata?.errorMessage || message.content;
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

<!-- The bottom padding clears the composer dock's fade, so the last line rests
     fully visible when scrolled to the end; text only fades while it scrolls
     past. Both are `--dock-gap`-sized: the 64px that used to sit here was dead
     air between every prompt and the composer. -->
<div bind:this={viewport} class="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-4 pt-6" onscroll={onScroll}>
  <div class="mx-auto flex min-w-0 flex-col gap-[var(--thread-gap)]" style="max-width: var(--thread-width);" use:followContentGrowth>
    {#each messages as message, messageIndex (message.id)}
      <div class="code-message-slot" class:is-live={message.status === 'streaming'}>
      <DeferredMessage content={message.content} immediate={messages.length < 60 || messageIndex >= messages.length - 6 || message.status === 'streaming'}>
      {#if message.role === 'user'}
        {@const queued = !!message.metadata?.codeQueued && !!run?.running}
        <div class="group relative flex flex-col items-end gap-1">
          <div class="max-w-[85%] break-words whitespace-pre-wrap rounded-3xl bg-muted px-5 py-2.5 text-sm leading-relaxed text-foreground" class:opacity-60={queued}>
            {message.content}
            {#if message.metadata?.codeAttachments?.length}
              <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {#each message.metadata.codeAttachments as attachment (attachment.path)}<MediaAttachmentCard {attachment} />{/each}
              </div>
            {/if}
          </div>
          {#if queued}<span class="flex items-center gap-1 text-xs text-muted-foreground"><Clock class="size-3" />{$t('code.message.queued')}</span>{/if}
          <!-- The actions hang half in the prompt's own bottom padding and half
               in the gap below it: no reserved line (16px per message), and the
               pointer stays inside the group while it travels to a button. The
               row is always hit-testable — hiding it with `pointer-events`
               would make it unreachable, since the hover that reveals it is the
               one it has to keep. -->
          <div class="absolute right-1 top-full z-10 -mt-2.5 flex items-center gap-2 rounded-full bg-popover/95 px-2 py-0.5 text-xs text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />{$t('code.message.copy')}</button>
            {#if message.metadata?.codeConversationIndex !== undefined && !run?.running}
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'fork')}><GitFork class="size-3" />{$t('code.message.fork')}</button>
              <button type="button" class="flex items-center gap-1" onclick={() => messageAction(message, 'rewind')}><RotateCcw class="size-3" />{$t('code.message.revert')}</button>
            {/if}
          </div>
        </div>
      {:else if message.metadata?.codeCompaction}
        <CompactionReport report={message.metadata.codeCompaction} />
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
        {@const orphans = unlinkedChildren(children, entries.flatMap((entry) => (entry.step ? [entry.step] : [])))}
        <div class="group flex min-w-0 flex-col gap-[var(--thread-gap)]">
          {#each blocks as block, index (block.key)}
            {#if block.items}
              <div class="-mx-2 min-w-0">
                <CodeWorkBlock items={block.items} {chatId} messageId={message.id} {children} live={streaming && index === blocks.length - 1} />
              </div>
            {:else}
              <div class="text-sm leading-relaxed text-foreground">
                <RichContent content={block.text} status={streaming && index === blocks.length - 1 ? 'streaming' : 'idle'} />
              </div>
            {/if}
          {/each}

          <!-- Background spawns: a child whose `task` step is above already
               draws on that step's row. -->
          {#if orphans.length}<SubagentGroup children={orphans} {chatId} messageId={message.id} />{/if}
          {#if diagnostics.length}
            <details class="text-xs text-muted-foreground"><summary class="cursor-pointer">{$t('code.runtimeNotes', { values: { n: diagnostics.length } })}</summary><div class="mt-2 space-y-1">{#each diagnostics as note, index (index)}<p>{note}</p>{/each}</div></details>
          {/if}

          <!-- What is happening now: always the last line, next to the composer. -->
          {#if streaming && live && run}
            <div class="-mx-2"><CodeLiveStatus {run} {awaitingApproval} /></div>
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
      </DeferredMessage>
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
    <!-- Back to the latest output: centred, above the composer, never over text.
         While the run is live it wears the meter, so being scrolled away from
         the status row no longer hides that the run is still working. -->
    <div class="pointer-events-none sticky bottom-2 flex justify-center">
      <JumpToLatest
        variant="float"
        class="pointer-events-auto"
        working={!!run?.running}
        mode={jumpMode}
        onclick={() => { pinnedToBottom = true; if (viewport) viewport.scrollTop = viewport.scrollHeight; }}
      />
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
    font-size: var(--text-sm);
    color: var(--foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .plan-reopen:hover {
    background: var(--surface-hover);
  }

  .code-message-slot { min-width: 0; content-visibility: auto; contain-intrinsic-size: auto 120px; }
  .code-message-slot.is-live { content-visibility: visible; }
</style>
