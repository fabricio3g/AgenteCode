<svelte:options runes={true} />

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import SpaceEmptyState from '$lib/components/chat/SpaceEmptyState.svelte';
  import EditMessageInline from './EditMessageInline.svelte';
  import SelectedTextAskAction from './SelectedTextAskAction.svelte';
  import {
    conversationDialWindow,
    conversationTimelinePreview
  } from '$lib/utils/conversation-timeline';

  interface TimelineMarker {
    id: string;
    role: 'user' | 'assistant';
    preview: string;
  }

  let container = $state<HTMLDivElement | undefined>(undefined);
  let showJumpToLatest = $state(false);
  let scrollRafId = 0;
  let timelineRafId = 0;
  let previousChatId = $state<string | null>(null);
  let previousMessageCount = $state(0);
  let scrollTicket = 0;
  let restoredActionsMessageId = $state<string | null>(null);
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let slotRefs = $state<Record<string, HTMLDivElement | undefined>>({});
  let previousEditingMessageId = $state<string | null>(null);
  let editAnchorTop = $state<number | null>(null);
  let timelineMarkers = $state<TimelineMarker[]>([]);
  let timelineScrollable = $state(false);
  let timelineDialIndex = $state(0);
  let timelineDialBrowsing = $state(false);
  let lastTimelineWheelAt = 0;
  let hoveredTimelineMessageId = $state<string | null>(null);
  const messages = $derived(appStore.currentChat?.messages || []);
  const contextMode = $derived(appStore.currentChat?.contextMode || 'chat');
  const hasMessages = $derived(messages.length > 0);
  const timelineDialMarkers = $derived.by(() =>
    conversationDialWindow(timelineMarkers.length, timelineDialIndex).map((entry) => ({
      ...timelineMarkers[entry.index],
      ...entry
    }))
  );
  const timelineDialPosition = $derived(
    timelineDialMarkers.find((marker) => marker.distance === 0)?.position ?? 50
  );
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
    queueTimelineRefresh();
  }

  function jumpToLatest() {
    scrollToBottom('smooth');
    showJumpToLatest = false;
    timelineDialBrowsing = false;
    selectTimelineDialIndex(timelineMarkers.length - 1, false);
    hoveredTimelineMessageId = null;
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

  function refreshTimeline() {
    if (!container) return;

    timelineScrollable = messages.length > 1;
    timelineMarkers = messages.map((message) => ({
      id: message.id,
      role: message.role,
      preview: conversationTimelinePreview(message)
    }));
    const latestIndex = Math.max(0, messages.length - 1);
    let currentMessageIndex = latestIndex;
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
          currentMessageIndex = index;
        }
      });
    }
    timelineDialIndex = timelineDialBrowsing
      ? Math.min(timelineDialIndex, latestIndex)
      : currentMessageIndex;
  }

  function queueTimelineRefresh() {
    cancelAnimationFrame(timelineRafId);
    timelineRafId = requestAnimationFrame(refreshTimeline);
  }

  function jumpToTimelineMessage(messageId: string) {
    const slot = slotRefs[messageId];
    if (!slot) return;
    slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    restoreActionsFor(messageId);
  }

  function selectTimelineDialIndex(index: number, revealPreview = true) {
    const latestIndex = Math.max(0, timelineMarkers.length - 1);
    timelineDialIndex = Math.min(latestIndex, Math.max(0, index));
    timelineDialBrowsing = timelineDialIndex !== latestIndex;
    if (revealPreview) {
      hoveredTimelineMessageId = timelineMarkers[timelineDialIndex]?.id || null;
    }
  }

  function handleTimelineWheel(event: WheelEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastTimelineWheelAt < 70 || Math.abs(event.deltaY) < 1) return;
    lastTimelineWheelAt = now;
    selectTimelineDialIndex(timelineDialIndex + (event.deltaY > 0 ? 1 : -1));
  }

  function selectAndJumpTimelineMessage(index: number, messageId: string) {
    selectTimelineDialIndex(index, false);
    jumpToTimelineMessage(messageId);
  }

  function handleTimelineKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      hoveredTimelineMessageId = null;
      (event.currentTarget as HTMLElement).blur();
    }
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
    const currentEditingMessageId = appStore.editingMessageId;
    if (currentEditingMessageId !== previousEditingMessageId) {
      captureEditAnchor(currentEditingMessageId || previousEditingMessageId);
    }
  });

  $effect(() => {
    const currentEditingMessageId = appStore.editingMessageId;
    if (currentEditingMessageId !== previousEditingMessageId) {
      const anchorMessageId = currentEditingMessageId || previousEditingMessageId;
      requestAnimationFrame(() => restoreEditAnchor(anchorMessageId));
      previousEditingMessageId = currentEditingMessageId;
    }
  });

  $effect(() => {
    window.addEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
    return () => window.removeEventListener('scroll-to-chat-message', handleScrollToChatMessage as EventListener);
  });

  $effect(() => {
    const scrollContainer = container;
    if (!scrollContainer) return;

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => queueTimelineRefresh());
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
        timelineDialBrowsing = false;
        scrollToBottom('auto');
        showJumpToLatest = false;
      } else if (countChanged) {
        if (nearBottom || isStreaming) {
          timelineDialBrowsing = false;
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
    <SpaceEmptyState />
  {:else}
    <div class="message-list-wrapper relative h-full">
      <SelectedTextAskAction />
      <div
        bind:this={container}
        id="conversation-message-scroll"
        class="message-scroll h-full overflow-y-auto px-4 pb-8 pt-6 md:px-8"
        role="region"
        aria-label="Conversation messages"
        onscroll={handleScroll}
        onwheel={() => (timelineDialBrowsing = false)}
        ontouchstart={() => (timelineDialBrowsing = false)}
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
                <ChatMessage {message} {contextMode} forceActionsVisible={restoredActionsMessageId === message.id} />
              {/if}
            </div>
          {/each}
        </div>
      </div>

      {#if timelineScrollable}
        <nav
          class="conversation-timeline"
          aria-label="Conversation dial. Use the mouse wheel to browse turns."
          onwheel={handleTimelineWheel}
          onmouseleave={() => (hoveredTimelineMessageId = null)}
        >
          <div class="timeline-scale">
            <span
              class="timeline-position-dot"
              style={`top:${timelineDialPosition}%;`}
              aria-hidden="true"
            ></span>

            {#each timelineDialMarkers as marker (marker.id)}
              <div
                class="timeline-marker"
                style={`top:${marker.position}%;`}
                role="group"
                aria-label={marker.role === 'user' ? 'User message marker' : 'Assistant response marker'}
                onmouseenter={() => (hoveredTimelineMessageId = marker.id)}
                onmouseleave={() => (hoveredTimelineMessageId = null)}
              >
                <button
                  type="button"
                  class:timeline-user={marker.role === 'user'}
                  class:timeline-assistant={marker.role === 'assistant'}
                  class:timeline-active={marker.distance === 0}
                  class:timeline-near={Math.abs(marker.distance) === 1}
                  class:timeline-mid={Math.abs(marker.distance) === 2}
                  class:timeline-far={Math.abs(marker.distance) >= 3}
                  class="timeline-marker-button"
                  aria-label={`Jump to ${marker.role === 'user' ? 'user message' : 'assistant response'}: ${marker.preview}`}
                  aria-describedby={hoveredTimelineMessageId === marker.id ? `timeline-tooltip-${marker.index}` : undefined}
                  aria-current={marker.distance === 0 ? 'true' : undefined}
                  onclick={() => selectAndJumpTimelineMessage(marker.index, marker.id)}
                  onfocus={() => (hoveredTimelineMessageId = marker.id)}
                  onblur={() => (hoveredTimelineMessageId = null)}
                  onkeydown={handleTimelineKeydown}
                >
                  <span class="timeline-line" aria-hidden="true"></span>
                </button>

                {#if hoveredTimelineMessageId === marker.id}
                  <div
                    id={`timeline-tooltip-${marker.index}`}
                    class="timeline-tooltip"
                    role="tooltip"
                  >
                    <span class="timeline-tooltip-role">
                      {marker.role === 'user' ? 'You' : 'Assistant'}
                    </span>
                    <span class="timeline-tooltip-preview">{marker.preview}</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </nav>
      {/if}

      {#if showJumpToLatest}
        <button
          type="button"
          class="jump-latest-btn"
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
    scrollbar-width: none;
  }

  .message-scroll::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .conversation-timeline {
    position: absolute;
    top: 50%;
    right: 0.25rem;
    z-index: 9;
    width: 1.35rem;
    height: min(8rem, calc(100% - 3rem));
    transform: translateY(-50%);
    border: 1px solid color-mix(in srgb, var(--border) 58%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--chat-bg) 82%, var(--surface));
    box-shadow: var(--shadow-xs);
    pointer-events: none;
  }

  .timeline-scale {
    position: absolute;
    inset: 0.55rem 0.22rem;
  }

  .timeline-position-dot {
    position: absolute;
    left: -0.08rem;
    z-index: 3;
    width: 3px;
    height: 3px;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background: var(--text);
    box-shadow: 0 0 0 2px var(--chat-bg);
    transition: top 120ms linear;
  }

  .timeline-marker {
    position: absolute;
    inset-inline: 0;
    z-index: 2;
    height: 0;
    pointer-events: auto;
    transition: top 140ms var(--motion-ease);
  }

  .timeline-marker-button {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    width: 0.8rem;
    height: 0.5rem;
    padding: 0;
    transform: translateY(-50%);
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
    outline: none;
  }

  .timeline-line {
    display: block;
    height: 1px;
    border-radius: 999px;
    opacity: 0.16;
    transition:
      width 120ms ease,
      opacity 120ms ease,
      background-color 120ms ease;
  }

  .timeline-user .timeline-line {
    width: 0.3rem;
    background: var(--text-secondary);
  }

  .timeline-assistant .timeline-line {
    width: 0.24rem;
    background: var(--text-muted);
  }

  .timeline-active .timeline-line {
    width: 0.7rem;
    height: 2px;
    opacity: 1;
    background: var(--text);
  }

  .timeline-near .timeline-line {
    width: 0.52rem;
    opacity: 0.68;
  }

  .timeline-mid .timeline-line {
    width: 0.4rem;
    opacity: 0.4;
  }

  .timeline-far .timeline-line {
    width: 0.26rem;
    opacity: 0.14;
  }

  .timeline-marker-button:hover .timeline-line,
  .timeline-marker-button:focus-visible .timeline-line {
    width: 0.66rem;
    opacity: 1;
    background: var(--text);
  }

  .timeline-marker-button:focus-visible {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 36%, transparent);
  }

  .timeline-tooltip {
    position: absolute;
    top: 0;
    right: calc(100% + 0.65rem);
    display: flex;
    width: min(13rem, calc(100vw - 4rem));
    max-height: 5rem;
    padding: 0.42rem 0.5rem;
    transform: translateY(-50%);
    flex-direction: column;
    gap: 0.2rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    color: var(--text);
    pointer-events: auto;
    animation: timelineTooltipIn 120ms ease-out;
  }

  .timeline-tooltip-role {
    color: var(--text-muted);
    font-size: 0.58rem;
    font-weight: 650;
    letter-spacing: 0.035em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .timeline-tooltip-preview {
    display: -webkit-box;
    overflow: hidden;
    font-size: 0.69rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  @keyframes timelineTooltipIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .jump-latest-btn {
    position: absolute;
    bottom: 1rem;
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
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.18);
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, opacity 150ms ease-out;
    animation: fadeInSoft 120ms ease-out;
  }

  .jump-latest-btn:hover {
    border-color: var(--border);
    background: color-mix(in srgb, var(--surface-hover) 88%, var(--chat-bg));
    color: var(--text);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.22), 0 4px 12px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.22);
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

  @media (prefers-reduced-motion: reduce) {
    .timeline-marker,
    .timeline-line,
    .timeline-position-dot {
      transition: none;
    }

    .timeline-tooltip {
      animation: none;
    }
  }
</style>
