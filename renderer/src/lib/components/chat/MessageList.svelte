<svelte:options runes={true} />

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import EditMessageInline from './EditMessageInline.svelte';

  interface Props {
    composerInset?: number;
  }

  let { composerInset = 320 }: Props = $props();

  let container = $state<HTMLDivElement | undefined>(undefined);
  let showTopFade = $state(false);
  let showJumpToLatest = $state(false);
  let scrollRafId = 0;
  let previousChatId = $state<string | null>(null);
  let previousMessageCount = $state(0);
  let scrollTicket = 0;
  const messages = $derived(appStore.currentChat?.messages || []);
  const hasMessages = $derived(messages.length > 0);
  const contentBottomInset = $derived(Math.max(composerInset + 24, 200));
  const jumpButtonBottom = $derived(Math.max(composerInset + 48, 176));
  const BOTTOM_THRESHOLD_PX = 96;

  function isNearBottom(): boolean {
    if (!container) return true;
    const distance = container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distance <= BOTTOM_THRESHOLD_PX;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = requestAnimationFrame(() => {
      container?.scrollTo({ top: container.scrollHeight, behavior });
    });
  }

  function handleScroll() {
    if (!container) return;
    const scrollTop = container.scrollTop;
    const nearBottom = isNearBottom();
    showTopFade = scrollTop > 40;
    showJumpToLatest = !nearBottom;
  }

  function jumpToLatest() {
    scrollToBottom('smooth');
    showJumpToLatest = false;
  }

  $effect(() => {
    const chatId = appStore.currentChatId;
    const messageCount = messages.length;
    const chatChanged = chatId !== previousChatId;
    const countChanged = messageCount !== previousMessageCount;
    if (!chatChanged && !countChanged) return;
    const isStreaming = messages.at(-1)?.status === 'streaming';
    const ticket = ++scrollTicket;

    tick().then(() => {
      if (ticket !== scrollTicket || !container) return;
      const nearBottom = isNearBottom();

      if (chatChanged) {
        scrollToBottom('auto');
        showJumpToLatest = false;
      } else if (countChanged) {
        if (nearBottom || isStreaming) {
          scrollToBottom(isStreaming ? 'auto' : 'smooth');
          showJumpToLatest = false;
        } else {
          showJumpToLatest = true;
        }
      }

      previousChatId = chatId;
      previousMessageCount = messageCount;
    });
  });
</script>

<div class="relative flex-1 min-h-0 overflow-hidden" style="background:var(--chat-bg)">
  {#if !hasMessages}
    <div class="h-full"></div>
  {:else}
    <div class="message-list-wrapper relative h-full">
      <div
        bind:this={container}
        class="h-full overflow-y-auto px-4 pt-6 md:px-8"
        style={`padding-bottom:${contentBottomInset}px;`}
        onscroll={handleScroll}
      >
        <div class="mx-auto flex max-w-[55rem] flex-col gap-7">
          {#each messages as message (message.id)}
            {#if appStore.editingMessageId === message.id}
              <EditMessageInline
                messageId={message.id}
                initialContent={appStore.editingMessageContent}
                role={message.role}
                onCancel={() => appStore.closeEditMessage()}
              />
            {:else}
              <ChatMessage {message} />
            {/if}
          {/each}
        </div>
      </div>
      <div class="message-list-fade message-list-fade-top pointer-events-none" class:visible={showTopFade}></div>
      <div class="message-list-fade message-list-fade-bottom pointer-events-none"></div>

      {#if showJumpToLatest}
        <button
          type="button"
          class="jump-latest-btn"
          style={`bottom:${jumpButtonBottom}px;`}
          onclick={jumpToLatest}
          aria-label={$t('chat.jumpToLatest')}
        >
          <ArrowDown class="h-4 w-4" />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .message-list-wrapper {
    position: relative;
    contain: layout style;
  }

  .message-list-fade {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 5;
    pointer-events: none;
  }

  .message-list-fade-top {
    top: 0;
    height: 80px;
    opacity: 0;
    transition: opacity 0.25s ease;
    background: linear-gradient(
      to bottom,
      var(--background) 0%,
      rgba(0,0,0,0) 100%
    );
  }

  .message-list-fade-top.visible {
    opacity: 1;
  }

  .message-list-fade-bottom {
    bottom: 0;
    height: 120px;
    opacity: 1;
    background: linear-gradient(
      to top,
      var(--chat-bg) 0%,
      transparent 100%
    );
  }

  .jump-latest-btn {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    z-index: 12;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-secondary);
    box-shadow: var(--shadow-sm);
    transition: transform 150ms ease-out, opacity 150ms ease-out, background 0.15s ease, color 0.15s ease;
    animation: slideUpFadeIn 150ms ease-out;
  }

  .jump-latest-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  @keyframes slideUpFadeIn {
    from {
      transform: translateX(-50%) translateY(1rem) scale(0.95);
      opacity: 0;
    }
    to {
      transform: translateX(-50%) translateY(0) scale(1);
      opacity: 1;
    }
  }
</style>
