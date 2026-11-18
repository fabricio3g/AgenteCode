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
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import CompactionReport from './CompactionReport.svelte';
  import { onDestroy } from 'svelte';
  import { ConversationFollow, distanceFromLatest, LATEST_BUTTON_DISTANCE, pauseOnScrollIntent } from '$lib/utils/conversation-scroll';
  import { reducedMotion } from '$lib/utils/motion.svelte';
  import { sentPromptEntry } from '$lib/utils/transitions';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { CircleCheck, ClipboardList, Clock, Copy, GitFork, History, RotateCcw, TriangleAlert } from '$lib/icons';
  import type { ChatMessage } from '$lib/types/chat';
  import DeferredMessage from '$lib/features/shared/DeferredMessage.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import MediaAttachmentCard from './MediaAttachmentCard.svelte';
  import CodeWorkBlock from './CodeWorkBlock.svelte';
  import SubagentTally from './SubagentTally.svelte';
  import { subagentFocus } from './subagent-focus.svelte';
  import CodeLiveStatus from './CodeLiveStatus.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import { withoutCodeErrorText } from './code-error';
  import { t } from 'svelte-i18n';
  import { copy, say } from '$lib/copy';
  import { formatDuration } from '$lib/utils/format';
  import { codeStore } from './code.svelte';
  import { orderedEntries } from './code-run';
  import JumpToLatest from '$lib/features/chat/thread/JumpToLatest.svelte';
  import ThreadTimeline from '$lib/features/chat/thread/ThreadTimeline.svelte';
  import { conversationTimelinePreview } from '$lib/utils/conversation-timeline';
  import type { TimelineMarker } from '$lib/features/chat/thread/timeline';
  import { runMeterMode } from './tile-meter';
  import { pendingPlan } from './plan-review';
  import { codeWorkspace } from './workspace.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { editedFiles, replyBlocks } from './work-blocks';
  import FileChangesCard from '$lib/components/agent/FileChangesCard.svelte';
  import { restoreCodeEdits } from './code-edits';
  import { appStore } from '$lib/stores/app.svelte';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  const follow = new ConversationFollow();
  let jumpVisible = $state(false);
  let timelineIndex = $state(0);
  let timelineBrowsing = $state(false);
  let timelineAwake = $state(false);
  let timelineTimer: ReturnType<typeof setTimeout> | undefined;
  const timelineMarkers = $derived<TimelineMarker[]>(messages.map(message => ({ id: message.id, role: message.role, preview: conversationTimelinePreview(message) })));

  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));
  const plan = $derived(pendingPlan(messages));

  /* Undo reverts the latest edits, so only the last reply that edited offers it. */
  const lastEditId = $derived([...messages].reverse().find((message) => message.role === 'assistant' && editedFiles(message.agentSteps ?? []).length)?.id);

  async function undoEdits() {
    const chat = appStore.chats.find((item) => item.id === chatId);
    if (!chat) return;
    try {
      await restoreCodeEdits(chat, 'undo');
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    }
  }

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
  onDestroy(() => { if (scrollFrame) cancelAnimationFrame(scrollFrame); if (timelineTimer) clearTimeout(timelineTimer); });
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
    if (follow.following && !scrollFrame) {
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (viewport && follow.following) snapToBottom();
      });
    }
  });

  function followContentGrowth(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      if (viewport) jumpVisible = distanceFromLatest(viewport) > LATEST_BUTTON_DISTANCE;
      if (!follow.following || scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (viewport && follow.following) snapToBottom();
      });
    });
    observer.observe(node);
    if (node.parentElement) observer.observe(node.parentElement);
    return { destroy: () => observer.disconnect() };
  }

  function onScroll() {
    if (!viewport) return;
    follow.observe(viewport);
    jumpVisible = distanceFromLatest(viewport) > LATEST_BUTTON_DISTANCE;
    timelineAwake = true;
    if (timelineTimer) clearTimeout(timelineTimer);
    timelineTimer = setTimeout(() => (timelineAwake = false), 1200);
    if (!timelineBrowsing) {
      const slots = viewport.querySelectorAll<HTMLElement>('.code-message-slot');
      const middle = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
      let low = 0, high = slots.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const rect = slots[mid].getBoundingClientRect();
        if (rect.top + rect.height / 2 < middle) low = mid + 1; else high = mid;
      }
      const center = (index: number) => { const rect = slots[index].getBoundingClientRect(); return rect.top + rect.height / 2; };
      timelineIndex = slots.length ? (low > 0 && Math.abs(center(low - 1) - middle) < Math.abs(center(low) - middle) ? low - 1 : low) : 0;
    }
  }

  function browseTimeline(index: number) {
    timelineIndex = Math.max(0, Math.min(messages.length - 1, index));
    timelineBrowsing = timelineIndex !== messages.length - 1;
  }

  function selectTimelineMessage(index: number) {
    browseTimeline(index);
    follow.pause();
    viewport?.querySelectorAll<HTMLElement>('.code-message-slot')[index]?.scrollIntoView({ behavior: reducedMotion.value ? 'auto' : 'smooth', block: 'start' });
  }

  function snapToBottom() {
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    follow.resume(viewport.scrollTop);
    jumpVisible = false;
  }

  function jumpToLatest() {
    if (!viewport) return;
    follow.resume(viewport.scrollTop);
    timelineBrowsing = false;
    timelineIndex = Math.max(0, messages.length - 1);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion.value ? 'auto' : 'smooth' });
  }

  $effect(() => {
    void chatId;
    follow.resume(0);
    const frame = requestAnimationFrame(snapToBottom);
    return () => cancelAnimationFrame(frame);
  });

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
    // Subagents have one place, the pill over the composer and its pane: their
    // spawn steps are not drawn here, so the step count leaves them out too.
    return withoutCodeErrorText(orderedEntries(message, live), diagnosticFor(message)).filter((entry) => entry.step?.toolName !== 'task');
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
<div class="thread-wrapper relative flex min-h-0 min-w-0 flex-1">
<div bind:this={viewport} class="conversation-scroll relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-4 pt-6" use:pauseOnScrollIntent={follow} onwheel={() => (timelineBrowsing = false)} onscroll={onScroll}>
  <div class="mx-auto flex min-w-0 flex-col gap-[var(--thread-gap)]" style="max-width: var(--thread-width);" use:followContentGrowth>
    {#each messages as message, messageIndex (message.id)}
      <div class="code-message-slot" class:is-live={message.status === 'streaming'}>
      <DeferredMessage content={message.content} immediate={messages.length < 60 || messageIndex >= messages.length - 6 || message.status === 'streaming'}>
      {#if message.role === 'user'}
        {@const queued = !!message.metadata?.codeQueued && !!run?.running}
        <div class="group relative flex flex-col items-end gap-1" use:sentPromptEntry={queued ? 0 : message.createdAt}>
          <div class="user-bubble whitespace-pre-wrap" class:opacity-60={queued}>
            {message.content}
            {#if message.metadata?.codeAttachments?.length}
              <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {#each message.metadata.codeAttachments as attachment (attachment.path)}<MediaAttachmentCard {attachment} />{/each}
              </div>
            {/if}
          </div>
          {#if queued}<span class="flex items-center gap-1 text-xs text-muted-foreground"><Clock class="size-3" />{$t('code.message.queued')}</span>{/if}
          <!-- Actions occupy their own line below the prompt, including in narrow panes. -->
          <div class="prompt-actions flex min-h-6 max-w-full flex-wrap items-center justify-end gap-2 px-2 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <UiButton variant="plain" type="button" class={uiClass("flex items-center gap-1", "ui-local-7965b84d")} onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />{$t('code.message.copy')}</UiButton>
            {#if message.metadata?.codeConversationIndex !== undefined && !run?.running}
              <UiButton variant="plain" type="button" class={uiClass("flex items-center gap-1", "ui-local-7965b84d")} onclick={() => messageAction(message, 'fork')}><GitFork class="size-3" />{$t('code.message.fork')}</UiButton>
              <UiButton variant="plain" type="button" class={uiClass("flex items-center gap-1", "ui-local-7965b84d")} onclick={() => messageAction(message, 'rewind')}><RotateCcw class="size-3" />{$t('code.message.revert')}</UiButton>
            {/if}
          </div>
        </div>
      {:else if message.metadata?.codeCompaction}
        <CompactionReport report={message.metadata.codeCompaction} />
      {:else if message.metadata?.codeNote && !message.content && !message.agentSteps?.length}
        <!-- A system note (restore, …): quiet, on the transcript's left edge. -->
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
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

          <!-- What the turn left on disk, once it has settled. -->
          {#if !streaming}
            {@const edits = editedFiles(entries.map((entry) => entry.step))}
            {#if edits.length}
              <FileChangesCard
                stats={edits}
                onreview={() => codeWorkspace.toggleChanges(true)}
                onundo={message.id === lastEditId && !run?.running ? undoEdits : undefined}
                onopenfile={(path) => codeWorkspace.showFileInChanges(path)}
              />
            {/if}
          {/if}

          <!-- The turn's subagents in one line; the pane holds the detail. -->
          {#if children.length}
            <button type="button" class="subagent-line" data-subagent-line={message.id}
              onclick={() => subagentFocus.open(chatId, (children.find((child) => child.status === 'running') ?? children[0]).id)}>
              <SubagentTally {children} stopping={live && !!run?.stopping} />
            </button>
          {/if}
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
          {#if message.content.trim() && !streaming}<UiButton variant="plain" type="button" class={uiClass("flex items-center gap-1 self-start text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100", "ui-local-7965b84d")} onclick={() => messageAction(message, 'copy')}><Copy class="size-3" />{$t('code.message.copy')}</UiButton>{/if}
        </div>
      {/if}
      </DeferredMessage>
      </div>
    {/each}
    {#if plan && !run?.running && codeWorkspace.plan?.chatId !== chatId}
      <UiButton variant="plain" type="button" class={uiClass("plan-reopen self-start", "ui-local-7965b84d")} onclick={() => codeWorkspace.showPlan(chatId, plan)}>
        <ClipboardList class="size-3.5" />
        <span class="truncate">{plan.title}</span>
        <span class="text-muted-foreground">· {$t('code.plan.open')}</span>
      </UiButton>
    {/if}
  </div>
  {#if jumpVisible}
    <!-- Back to the latest output: centred, above the composer, never over text.
         While the run is live it wears the meter, so being scrolled away from
         the status row no longer hides that the run is still working. -->
    <div class="pointer-events-none sticky bottom-2 flex justify-center">
      <JumpToLatest
        variant="float"
        class="pointer-events-auto"
        working={!!run?.running}
        mode={jumpMode}
        onclick={jumpToLatest}
      />
    </div>
  {/if}
</div>
  {#if timelineMarkers.length >= 4}
    <ThreadTimeline markers={timelineMarkers} index={timelineIndex} awake={timelineAwake} onbrowse={browseTimeline} onselect={selectTimelineMessage} />
  {/if}
</div>

<style>
  .run-chip {
    opacity: 0.85;
  }

  :global(.plan-reopen.ui-local-7965b84d) {
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
  :global(.plan-reopen:hover.ui-local-7965b84d) {
    background: var(--surface-hover);
  }

  .code-message-slot { min-width: 0; content-visibility: auto; contain-intrinsic-size: auto 120px; }
  .code-message-slot.is-live { content-visibility: visible; }
  /* One quiet line per turn; hover lifts it like any row that opens a pane. */
  .subagent-line { display: inline-flex; align-self: flex-start; align-items: center; gap: 0.375rem; height: 1.75rem; margin-inline: -0.5rem; padding: 0 0.5rem; border: 0; border-radius: var(--radius-full); background: none; color: var(--muted-foreground); font: inherit; font-size: var(--text-xs); font-variant-numeric: tabular-nums; cursor: pointer; transition: background-color var(--motion-instant) var(--motion-ease); }
  .subagent-line:hover { background: var(--float-row-hover); }
  .subagent-line:focus-visible { outline: 2px solid var(--brand-accent); outline-offset: 1px; }
</style>
