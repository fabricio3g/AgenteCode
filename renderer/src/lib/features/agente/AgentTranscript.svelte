<svelte:options runes={true} />

<script lang="ts">
  import { tick } from 'svelte';
  import { Bot, User } from 'lucide-svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import ToolCallRow from '$lib/components/agent/ToolCallRow.svelte';
  import ApprovalRequest from '$lib/components/agent/ApprovalRequest.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';

  let { messages, chatId }: { messages: ChatMessage[]; chatId: string } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinnedToBottom = $state(true);

  const pendingApprovals = $derived(approvalsStore.forChat(chatId));

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
            <details class="group rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <summary class="cursor-pointer select-none font-medium">Thinking</summary>
              <div class="mt-2 whitespace-pre-wrap leading-relaxed">{message.reasoning}</div>
            </details>
          {/if}

          {#if message.agentSteps?.length}
            <div class="flex flex-col gap-1.5">
              {#each message.agentSteps as step (step.id)}
                <ToolCallRow {step} />
              {/each}
            </div>
          {/if}

          {#if message.content}
            <div class="flex items-start gap-2.5">
              <div class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Bot class="size-3.5 text-muted-foreground" />
              </div>
              <div class="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
                <RichContent content={message.content} />
              </div>
            </div>
          {:else if message.status === 'streaming' && !message.agentSteps?.length}
            <div class="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <span class="thinking-dots" aria-label="Working"></span>
            </div>
          {/if}

          {#if message.status === 'error'}
            <p class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              {message.content || 'The run failed.'}
            </p>
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
    animation: agente-pulse 1.2s ease-in-out infinite;
  }
  .thinking-dots::before {
    left: 0.25rem;
  }
  .thinking-dots::after {
    left: 0.85rem;
    animation-delay: 0.2s;
  }
  @keyframes agente-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }
</style>
