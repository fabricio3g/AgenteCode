<svelte:options runes={true} />

<!--
  The Code space transcript.

  The user speaks in a quiet right-aligned bubble; the agent
  answers full-width — thinking as a collapsible ReasoningBlock, tool work as
  inline chronological rows, then the answer. No avatars; hierarchy comes
  from alignment and type, not from icon boxes.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { AlertCircle, CircleCheck, TriangleAlert } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import ReasoningBlock from '$lib/ui/components/ReasoningBlock.svelte';
  import ToolCallRow from '$lib/components/agent/ToolCallRow.svelte';
  import ApprovalRequest from '$lib/components/agent/ApprovalRequest.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { t } from 'svelte-i18n';
  import { codeStore } from './code.svelte';
  import TodoList from './TodoList.svelte';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  const pendingApprovals = $derived(approvalsStore.forChat(chatId));
  /** Live run state for retry + todo visibility while streaming. */
  const run = $derived(codeStore.runFor(chatId));

  $effect(() => {
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
</script>

<div bind:this={viewport} class="flex-1 overflow-y-auto px-4 py-6" onscroll={onScroll}>
  <div class="mx-auto flex max-w-3xl flex-col gap-5">
    {#each messages as message (message.id)}
      {#if message.role === 'user'}
        <div class="flex justify-end">
          <div class="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap">
            {message.content}
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-2">
          {#if message.reasoning}
            <ReasoningBlock
              reasoning={message.reasoning}
              status={message.status}
              variant="outline"
            />
          {/if}

          {#if message.agentSteps?.length}
            <div class="flex flex-col gap-1.5">
              {#each message.agentSteps as step (step.id)}
                <ToolCallRow {step} />
              {/each}
            </div>
          {/if}

          {#if message.status === 'streaming' && run?.todos.length}
            <TodoList todos={run.todos} />
          {/if}

          {#if message.content}
            <div class="text-sm leading-relaxed text-foreground">
              <RichContent content={message.content} />
              {#if message.status === 'streaming'}<span class="stream-caret" aria-hidden="true"></span>{/if}
            </div>
          {:else if message.status === 'streaming' && !message.agentSteps?.length && !message.reasoning}
            <div class="flex items-center px-1 text-xs text-muted-foreground">
              <span class="thinking-dots" aria-label="Working"></span>
            </div>
          {/if}

          {#if message.status === 'streaming' && run?.retrying}
            {@const retry = run.retrying}
            <div class="flex items-center gap-2 self-start rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
              <span class="retry-dot" aria-hidden="true"></span>
              {$t('code.retrying', { values: { n: retry.attempt } })}
            </div>
          {/if}

          {#if message.status === 'error'}
            {@const reason = message.metadata?.errorMessage || message.content || 'The run failed.'}
            <div class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
              <span class="min-w-0 break-words">{reason}</span>
            </div>
          {:else if message.done && message.status !== 'streaming' && message.metadata?.codeStopReason}
            {@const reason = message.metadata.codeStopReason}
            {#if reason === 'stop'}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-muted-foreground">
                <CircleCheck class="size-3" />
                {$t('code.statusCompleted')}
              </div>
            {:else if reason === 'aborted'}
              <div class="run-chip flex items-center gap-1.5 self-start text-[11px] text-muted-foreground">
                {$t('code.statusStopped')}
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

    {#if pendingApprovals.length}
      <ApprovalRequest approvals={pendingApprovals} />
    {/if}
  </div>
</div>

<style>
  .run-chip {
    opacity: 0.85;
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

  /* Streaming caret: a breathing block at the content tail — presence without
     a spinner, in the monochrome grammar of the rest of the surface. */
  .stream-caret {
    display: inline-block;
    width: 0.5rem;
    height: 1em;
    margin-left: 0.15rem;
    vertical-align: text-bottom;
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
