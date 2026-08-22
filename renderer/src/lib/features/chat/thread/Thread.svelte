<svelte:options runes={true} />

<!--
  The scrolling conversation viewport.

  Owns three things and nothing else: stick-to-bottom behavior during streaming,
  the per-message slot registry that lets anything scroll a message into view,
  and scroll-position preservation while a message is being edited in place.
  Navigation lives in ThreadTimeline; message rendering lives in Message.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { conversationTimelinePreview } from '$lib/utils/conversation-timeline';
  import EditMessageInline from '$lib/features/chat/EditMessageInline.svelte';
  import SelectedTextAskAction from '$lib/features/chat/SelectedTextAskAction.svelte';
  import Message from './Message.svelte';
  import ThreadTimeline from './ThreadTimeline.svelte';
  import type { TimelineMarker } from './timeline';

  /** Treat anything within this many pixels of the bottom as "at the bottom". */
  const BOTTOM_THRESHOLD_PX = 96;
  /** How long the action bar stays pinned after jumping to a message. */
  const ACTION_PIN_MS = 1400;

  let container = $state<HTMLDivElement | undefined>(undefined);
  let showJumpToLatest = $state(false);
  let scrollRafId = 0;
  let timelineRafId = 0;
  let previousChatId = $state<string | null>(null);
  let previousMessageCount = $state(0);
  let scrollTicket = 0;
  let pinnedMessageId = $state<string | null>(null);
  let pinTimer: ReturnType<typeof setTimeout> | null = null;
  let slotRefs = $state<Record<string, HTMLDivElement | undefined>>({});
  let previousEditingMessageId = $state<string | null>(null);
  let editAnchorTop = $state<number | null>(null);
  let timelineMarkers = $state<TimelineMarker[]>([]);
  let timelineIndex = $state(0);
  let timelineBrowsing = $state(false);

  const messages = $derived(appStore.currentChat?.messages || []);
  const contextMode = $derived(appStore.currentChat?.contextMode || 'home');
  const hasMessages = $derived(messages.length > 0);
  const showTimeline = $derived(messages.length > 1);

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
    showJumpToLatest = !isNearBottom();
    queueTimelineRefresh();
  }

  function jumpToLatest() {
    scrollToBottom('smooth');
    showJumpToLatest = false;
    timelineBrowsing = false;
    timelineIndex = Math.max(0, timelineMarkers.length - 1);
  }

  function pinActionsFor(messageId: string) {
    pinnedMessageId = messageId;
    if (pinTimer) clearTimeout(pinTimer);
    pinTimer = setTimeout(() => {
      pinnedMessageId = null;
      pinTimer = null;
    }, ACTION_PIN_MS);
  }

  function scrollMessageIntoView(messageId: string, block: ScrollLogicalPosition) {
    const slot = slotRefs[messageId];
    if (!slot) return;
    slot.scrollIntoView({ behavior: 'smooth', block });
    pinActionsFor(messageId);
  }

  function handleScrollToChatMessage(event: Event) {
    const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
    if (messageId) scrollMessageIntoView(messageId, 'center');
  }

  /**
   * Recompute the dial. While the user is near the bottom the dial simply
   * follows the latest turn; otherwise it points at whichever message is
   * closest to the middle of the viewport.
   */
  function refreshTimeline() {
    if (!container) return;

    timelineMarkers = messages.map((message) => ({
      id: message.id,
      role: message.role,
      preview: conversationTimelinePreview(message)
    }));

    const latestIndex = Math.max(0, messages.length - 1);
    let currentIndex = latestIndex;

    if (!isNearBottom()) {
      const viewportCenter = container.getBoundingClientRect().top + container.clientHeight / 2;
      let nearestDistance = Number.POSITIVE_INFINITY;
      messages.forEach((message, index) => {
        const slot = slotRefs[message.id];
        if (!slot) return;
        const bounds = slot.getBoundingClientRect();
        const distance = Math.abs(bounds.top + bounds.height / 2 - viewportCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          currentIndex = index;
        }
      });
    }

    timelineIndex = timelineBrowsing ? Math.min(timelineIndex, latestIndex) : currentIndex;
  }

  function queueTimelineRefresh() {
    cancelAnimationFrame(timelineRafId);
    timelineRafId = requestAnimationFrame(refreshTimeline);
  }

  function browseTimeline(index: number) {
    const latestIndex = Math.max(0, timelineMarkers.length - 1);
    timelineIndex = Math.min(latestIndex, Math.max(0, index));
    timelineBrowsing = timelineIndex !== latestIndex;
  }

  function selectTimelineMessage(index: number, messageId: string) {
    browseTimeline(index);
    scrollMessageIntoView(messageId, 'start');
  }

  function captureEditAnchor(messageId: string | null) {
    if (!messageId || !container) return;
    const slot = slotRefs[messageId];
    if (!slot) return;
    editAnchorTop = slot.getBoundingClientRect().top;
  }

  /** Swapping a bubble for an editor changes its height; absorb the shift. */
  function restoreEditAnchor(messageId: string | null) {
    if (!messageId || !container || editAnchorTop == null) return;
    const slot = slotRefs[messageId];
    if (!slot) return;
    const delta = slot.getBoundingClientRect().top - editAnchorTop;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    editAnchorTop = null;
  }

  function registerSlot(node: HTMLDivElement, messageId: string) {
    slotRefs = { ...slotRefs, [messageId]: node };
    queueTimelineRefresh();
    return {
      destroy() {
        const next = { ...slotRefs };
        delete next[messageId];
        slotRefs = next;
        queueTimelineRefresh();
      }
    };
  }

  $effect.pre(() => {
    const editingId = appStore.editingMessageId;
    if (editingId !== previousEditingMessageId) {
      captureEditAnchor(editingId || previousEditingMessageId);
    }
  });

  $effect(() => {
    const editingId = appStore.editingMessageId;
    if (editingId === previousEditingMessageId) return;
    const anchorId = editingId || previousEditingMessageId;
    requestAnimationFrame(() => restoreEditAnchor(anchorId));
    previousEditingMessageId = editingId;
  });

  $effect(() => {
    window.addEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
    return () =>
      window.removeEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
  });

  $effect(() => {
    const scrollContainer = container;
    if (!scrollContainer) return;

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => queueTimelineRefresh());
    observer?.observe(scrollContainer);
    const content = scrollContainer.firstElementChild;
    if (content) observer?.observe(content);
    queueTimelineRefresh();

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(timelineRafId);
    };
  });

  $effect(() => {
    void messages.length;
    void slotRefs;
    tick().then(queueTimelineRefresh);
  });

  // Stick to the bottom on chat switch, and on new messages when the user was
  // already following along. A ticket guards against overlapping runs.
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

      if (chatChanged) {
        timelineBrowsing = false;
        scrollToBottom('auto');
        showJumpToLatest = false;
      } else if (isNearBottom() || isStreaming) {
        timelineBrowsing = false;
        scrollToBottom(isStreaming ? 'auto' : 'smooth');
        showJumpToLatest = false;
      } else {
        showJumpToLatest = true;
      }

      previousChatId = chatId;
      previousMessageCount = messageCount;
    });
  });

  $effect(() => () => {
    if (pinTimer) clearTimeout(pinTimer);
  });
</script>

<!--
  With no messages the thread collapses entirely so the shell can centre the
  composer on its own — the input is the invitation, it doesn't need a heading
  telling the reader to type. Once a conversation starts the thread claims the
  remaining height and the composer settles at the bottom.
-->
<div
  class="relative min-h-0 overflow-hidden {hasMessages ? 'flex-1' : 'hidden'}"
  style="background:var(--chat-bg)"
>
  {#if hasMessages}
    <div class="thread-wrapper relative h-full">
      <SelectedTextAskAction />

      <div
        bind:this={container}
        id="conversation-message-scroll"
        class="thread-scroll h-full overflow-y-auto px-4 pb-8 md:px-8"
        style="padding-top: var(--thread-top-pad);"
        role="region"
        aria-label="Conversation messages"
        onscroll={handleScroll}
        onwheel={() => (timelineBrowsing = false)}
        ontouchstart={() => (timelineBrowsing = false)}
      >
        <div
          class="mx-auto flex w-full flex-col gap-7"
          style="max-width: var(--thread-width);"
        >
          {#each messages as message (message.id)}
            <div class="message-slot" use:registerSlot={message.id}>
              {#if appStore.editingMessageId === message.id}
                <div
                  class="edit-inline-container {message.role === 'user' ? 'is-user' : 'is-assistant'}"
                >
                  <EditMessageInline
                    messageId={message.id}
                    initialContent={appStore.editingMessageContent}
                    role={message.role}
                    onCancel={() => appStore.closeEditMessage()}
                    onDone={() => pinActionsFor(message.id)}
                  />
                </div>
              {:else}
                <Message
                  {message}
                  {contextMode}
                  forceActionsVisible={pinnedMessageId === message.id}
                />
              {/if}
            </div>
          {/each}
        </div>
      </div>

      {#if showTimeline}
        <ThreadTimeline
          markers={timelineMarkers}
          index={timelineIndex}
          onselect={selectTimelineMessage}
          onbrowse={browseTimeline}
        />
      {/if}

      {#if showJumpToLatest}
        <button
          type="button"
          class="jump-latest-btn"
          onclick={jumpToLatest}
          aria-label={copy.thread.jumpToLatest}
          title={copy.thread.jumpToLatest}
        >
          <ArrowDown class="h-4 w-4" />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .thread-wrapper {
    position: relative;
    contain: layout style;
  }

  .thread-scroll {
    scroll-behavior: smooth;
    scrollbar-width: none;
  }

  .thread-scroll::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .message-slot {
    position: relative;
  }

  .jump-latest-btn {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    z-index: var(--z-sticky);
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    transform: translateX(-50%);
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
    border-radius: 9999px;
    background: color-mix(in srgb, var(--chat-bg) 92%, var(--card));
    color: var(--muted-foreground);
    backdrop-filter: blur(8px);
    box-shadow:
      0 10px 26px rgba(0, 0, 0, 0.18),
      0 2px 8px rgba(0, 0, 0, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
    transition:
      background 0.15s ease,
      color 0.15s ease,
      border-color 0.15s ease,
      box-shadow 0.15s ease;
    animation: fadeInSoft 120ms ease-out;
  }

  .jump-latest-btn:hover {
    border-color: var(--border);
    background: color-mix(in srgb, var(--surface-hover) 88%, var(--chat-bg));
    color: var(--foreground);
    box-shadow:
      0 14px 32px rgba(0, 0, 0, 0.22),
      0 4px 12px rgba(0, 0, 0, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }

  @keyframes fadeInSoft {
    from { opacity: 0; }
    to { opacity: 1; }
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
