<svelte:options runes={true} />

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import EditMessageInline from './EditMessageInline.svelte';
  import SelectedTextAskAction from './SelectedTextAskAction.svelte';

  interface Props {
    composerInset?: number;
  }

  let { composerInset = 320 }: Props = $props();

  let container = $state<HTMLDivElement | undefined>(undefined);
  let showJumpToLatest = $state(false);
  let scrollRafId = 0;
  let previousChatId = $state<string | null>(null);
  let previousMessageCount = $state(0);
  let scrollTicket = 0;
  let restoredActionsMessageId = $state<string | null>(null);
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let slotRefs = $state<Record<string, HTMLDivElement | undefined>>({});
  let previousEditingMessageId = $state<string | null>(null);
  let editAnchorTop = $state<number | null>(null);
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
    const nearBottom = isNearBottom();
    showJumpToLatest = !nearBottom;
  }

  function jumpToLatest() {
    scrollToBottom('smooth');
    showJumpToLatest = false;
  }

  function handleScrollToChatMessage(event: Event) {
    const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
    if (!messageId) return;
    const slot = slotRefs[messageId];
    slot?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    restoreActionsFor(messageId);
  }

  function restoreActionsFor(messageId: string) {
    restoredActionsMessageId = messageId;
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoredActionsMessageId = null;
      restoreTimer = null;
    }, 1400);
  }

  function captureEditAnchor(messageId: string | null) {
    if (!messageId || !container) return;
    const slot = slotRefs[messageId];
    if (!slot) return;
    editAnchorTop = slot.getBoundingClientRect().top;
  }

  function restoreEditAnchor(messageId: string | null) {
    if (!messageId || !container || editAnchorTop == null) return;
    const slot = slotRefs[messageId];
    if (!slot) return;
    const nextTop = slot.getBoundingClientRect().top;
    const delta = nextTop - editAnchorTop;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    editAnchorTop = null;
  }

  function registerSlot(node: HTMLDivElement, messageId: string) {
    slotRefs = { ...slotRefs, [messageId]: node };
    return {
      destroy() {
        const next = { ...slotRefs };
        delete next[messageId];
        slotRefs = next;
      }
    };
  }

  $effect(() => {
    const currentEditingMessageId = appStore.editingMessageId;
    if (currentEditingMessageId !== previousEditingMessageId) {
      if (currentEditingMessageId) {
        captureEditAnchor(currentEditingMessageId);
      } else {
        const closedMessageId = previousEditingMessageId;
        requestAnimationFrame(() => restoreEditAnchor(closedMessageId));
      }
      previousEditingMessageId = currentEditingMessageId;
    }
  });

  $effect(() => {
    window.addEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
    return () => window.removeEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
  });

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
      <SelectedTextAskAction />
      <div
        bind:this={container}
        class="message-scroll h-full overflow-y-auto px-4 pt-6 md:px-8"
        style={`padding-bottom:${contentBottomInset}px;`}
        onscroll={handleScroll}
      >
        <div class="mx-auto flex max-w-[55rem] flex-col gap-7">
          {#each messages as message (message.id)}
            <div class="message-slot" use:registerSlot={message.id}>
              {#if appStore.editingMessageId === message.id}
                <div class={`edit-inline-container ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                  <EditMessageInline
                    messageId={message.id}
                    initialContent={appStore.editingMessageContent}
                    role={message.role}
                    onCancel={() => appStore.closeEditMessage()}
                    onDone={() => restoreActionsFor(message.id)}
                  />
                </div>
              {:else}
                <ChatMessage {message} forceActionsVisible={restoredActionsMessageId === message.id} />
              {/if}
            </div>
          {/each}
        </div>
      </div>

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

  .message-scroll {
    scroll-behavior: smooth;
  }

  .jump-latest-btn {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    z-index: 8;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 9999px;
    border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
    background: color-mix(in srgb, var(--chat-bg) 92%, var(--surface));
    color: var(--text-secondary);
    backdrop-filter: blur(8px);
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 150ms ease-out;
    animation: fadeInSoft 120ms ease-out;
  }

  .jump-latest-btn:hover {
    border-color: var(--border);
    background: color-mix(in srgb, var(--surface-hover) 88%, var(--chat-bg));
    color: var(--text);
  }

  @keyframes fadeInSoft {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .message-slot {
    position: relative;
  }

  .edit-inline-container {
    animation: editFadeSlide 180ms ease-out forwards;
  }

  .edit-inline-container.is-user {
    margin-left: auto;
    max-width: min(46rem, 84%);
  }

  .edit-inline-container.is-assistant {
    max-width: 100%;
  }

  @keyframes editFadeSlide {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
