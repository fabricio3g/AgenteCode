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
  import { threadJump } from './thread-jump.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { reducedMotion } from '$lib/utils/motion.svelte';
  import { conversationTimelinePreview } from '$lib/utils/conversation-timeline';
  import EditMessageInline from '$lib/features/chat/EditMessageInline.svelte';
  import SelectedTextAskAction from '$lib/features/chat/SelectedTextAskAction.svelte';
  import Message from './Message.svelte';
  import DeferredMessage from '$lib/features/shared/DeferredMessage.svelte';
  import ThreadTimeline from './ThreadTimeline.svelte';
  import type { TimelineMarker } from './timeline';
  let { density = 'comfortable' }: { density?: 'comfortable' | 'compact' } = $props();

  /** Treat anything within this many pixels of the bottom as "at the bottom". */
  const BOTTOM_THRESHOLD_PX = 96;
  /** Resume following once the user scrolls back this close to the live edge. */
  const FOLLOW_RESUME_PX = 32;
  /** How long the action bar stays pinned after jumping to a message. */
  const ACTION_PIN_MS = 1400;

  let container = $state<HTMLDivElement | undefined>(undefined);
  let timelineRafId = 0;
  let previousChatId = $state<string | null>(null);
  let previousMessageCount = $state(0);
  let scrollTicket = 0;
  let pinnedMessageId = $state<string | null>(null);
  let pinTimer: ReturnType<typeof setTimeout> | null = null;
  const slotRefs = new Map<string, HTMLDivElement>();
  let previousEditingMessageId = $state<string | null>(null);
  let editAnchorTop = $state<number | null>(null);
  let timelineIndex = $state(0);
  let timelineBrowsing = $state(false);
  /** Stick to the live edge while true. Any user scroll away pauses it; scrolling
   * back to the bottom resumes it. Programmatic jumps land at the bottom, so
   * they converge on the same state without special-casing. */
  let followingLatest = true;
  /** Past this distance from the bottom the composer offers a way back. */
  const JUMP_BUTTON_PX = 320;

  const messages = $derived(appStore.currentChat?.messages || []);
  const timelineMarkers = $derived<TimelineMarker[]>(messages.map(message => ({
    id: message.id, role: message.role, preview: conversationTimelinePreview(message)
  })));

  const contextMode = $derived(appStore.currentChat?.contextMode || 'home');
  const hasMessages = $derived(messages.length > 0);
  // Short chats don't need a dial; it would only add noise.
  const showTimeline = $derived(messages.length >= 4);
  /** True briefly after a scroll, so the dial wakes up while you move. */
  let scrollAwake = $state(false);
  let scrollAwakeTimer: ReturnType<typeof setTimeout> | null = null;

  function distanceToBottom(): number {
    if (!container) return 0;
    return container.scrollHeight - (container.scrollTop + container.clientHeight);
  }

  function isNearBottom(): boolean {
    return distanceToBottom() <= BOTTOM_THRESHOLD_PX;
  }

  function snapToBottom() {
    followingLatest = true;
    threadJump.visible = false;
    if (container) container.scrollTop = container.scrollHeight;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    followingLatest = true;
    container?.scrollTo({
      top: container.scrollHeight,
      behavior: reducedMotion.value ? 'auto' : behavior
    });
  }

  /** Content grew mid-stream: stay pinned instantly when following, never ease.
   * Easing perpetually lags a fast stream and fights the user's own scrolling. */
  function followContentGrowth() {
    if (!followingLatest || appStore.editingMessageId || !container) return;
    container.scrollTop = container.scrollHeight;
  }

  function handleScroll() {
    if (!container) return;
    const distance = distanceToBottom();
    if (distance <= FOLLOW_RESUME_PX) followingLatest = true;
    else if (distance > BOTTOM_THRESHOLD_PX) followingLatest = false;
    threadJump.visible = distance > JUMP_BUTTON_PX;
    queueTimelineRefresh();
    scrollAwake = true;
    if (scrollAwakeTimer) clearTimeout(scrollAwakeTimer);
    scrollAwakeTimer = setTimeout(() => (scrollAwake = false), 1200);
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
    const slot = slotRefs.get(messageId);
    if (!slot) return;
    followingLatest = false;
    slot.scrollIntoView({ behavior: reducedMotion.value ? 'auto' : 'smooth', block });
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

    const latestIndex = Math.max(0, messages.length - 1);
    let currentIndex = latestIndex;

    if (!isNearBottom()) {
      const viewportCenter = container.getBoundingClientRect().top + container.clientHeight / 2;
      // Slot centers are ordered. Inspect O(log n) bounds instead of forcing
      // geometry reads for the entire transcript on every scroll frame.
      let low = 0;
      let high = latestIndex;
      const center = (index: number) => {
        const bounds = slotRefs.get(messages[index].id)?.getBoundingClientRect();
        return bounds ? bounds.top + bounds.height / 2 : Number.POSITIVE_INFINITY;
      };
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (center(middle) < viewportCenter) low = middle + 1;
        else high = middle;
      }
      currentIndex = low > 0 && Math.abs(center(low - 1) - viewportCenter) < Math.abs(center(low) - viewportCenter)
        ? low - 1 : low;
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
    const slot = slotRefs.get(messageId);
    if (!slot) return;
    editAnchorTop = slot.getBoundingClientRect().top;
  }

  /** Swapping a bubble for an editor changes its height; absorb the shift. */
  function restoreEditAnchor(messageId: string | null) {
    if (!messageId || !container || editAnchorTop == null) return;
    const slot = slotRefs.get(messageId);
    if (!slot) return;
    const delta = slot.getBoundingClientRect().top - editAnchorTop;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    editAnchorTop = null;
  }

  function registerSlot(node: HTMLDivElement, messageId: string) {
    slotRefs.set(messageId, node);
    queueTimelineRefresh();
    return {
      destroy() {
        slotRefs.delete(messageId);
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
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        queueTimelineRefresh();
        followContentGrowth();
      });
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
        snapToBottom();
      } else if (followingLatest) {
        timelineBrowsing = false;
        if (isStreaming) snapToBottom();
        else scrollToBottom('smooth');
      }

      previousChatId = chatId;
      previousMessageCount = messageCount;
    });
  });

  $effect(() => {
    threadJump.jump = () => scrollToBottom('smooth');
    return () => {
      threadJump.jump = null;
      threadJump.visible = false;
    };
  });

  $effect(() => () => {
    if (pinTimer) clearTimeout(pinTimer);
    cancelAnimationFrame(timelineRafId);
    scrollTicket++;
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
    <div class="thread-wrapper ui-top-fade h-full">
      <SelectedTextAskAction />

      <div
        bind:this={container}
        id="conversation-message-scroll"
        class="thread-scroll h-full overflow-y-auto px-4 pb-12 md:px-8"
        style="padding-top: var(--thread-top-pad);"
        role="region"
        aria-label="Conversation messages"
        onscroll={handleScroll}
      >
        <div
          class="mx-auto flex w-full flex-col {density === 'compact' ? 'gap-4' : 'gap-7'}"
          style="max-width: var(--thread-width);"
        >
          {#each messages as message, index (message.id)}
            <div class="message-slot" class:is-live={message.status === 'streaming' || appStore.editingMessageId === message.id} use:registerSlot={message.id}>
              <DeferredMessage content={message.content} immediate={messages.length < 60 || index >= messages.length - 6 || message.status === 'streaming' || appStore.editingMessageId === message.id}>
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
              </DeferredMessage>
            </div>
          {/each}
        </div>
      </div>

      {#if showTimeline}
        <ThreadTimeline
          markers={timelineMarkers}
          index={timelineIndex}
          awake={scrollAwake}
          onselect={selectTimelineMessage}
          onbrowse={browseTimeline}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .thread-wrapper {
    --ui-top-fade-from: var(--chat-bg);
    contain: layout style;
  }

  /* No smooth scrolling here: programmatic jumps choose their own behavior and
     instant follow updates must not be eased, or the live edge lags the stream. */
  .thread-scroll {
    scrollbar-width: none;
  }


  .thread-scroll::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .message-slot {
    position: relative;
    content-visibility: auto;
    contain-intrinsic-size: auto 160px;
  }

  .message-slot.is-live {
    content-visibility: visible;
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
