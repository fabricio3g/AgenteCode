<svelte:options runes={true} />

<!--
  Resolves everything a message's children need, publishes it as context, then
  routes on role. Nothing below this component takes `message` as a prop.
-->

<script lang="ts">
  import type { ChatContextMode, ChatMessage, SearchMeta } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { sanitizeAssistantVisibleText } from '$lib/utils/assistant-visible';
  import AssistantMessage from './AssistantMessage.svelte';
  import UserMessage from './UserMessage.svelte';
  import { createMessageContext, type MessageContextValue } from './message-context';
  import { isAssistantMessageEmpty } from './message-parts';

  interface Props {
    message: ChatMessage;
    contextMode?: ChatContextMode;
    /** Keep the action bar visible, e.g. right after jumping to this message. */
    forceActionsVisible?: boolean;
  }

  let { message, contextMode = 'home', forceActionsVisible = false }: Props = $props();

  let hovering = $state(false);
  let menuOpen = $state(false);

  const versions = $derived(message.versions || []);
  const versionCount = $derived(Math.max(1, versions.length));
  const activeVersionIndex = $derived(
    typeof message.activeVersion === 'number'
      ? Math.max(0, Math.min(message.activeVersion, versionCount - 1))
      : 0
  );
  const activeVersion = $derived(versions[activeVersionIndex] || null);
  const isStreaming = $derived(message.status === 'streaming');

  const rawContent = $derived(activeVersion?.content || message.content || '');
  // Assistant text is sanitized once settled; mid-stream it is left alone so the
  // sanitizer never truncates a partial construct it hasn't seen the end of.
  const displayContent = $derived(
    message.role === 'assistant' && !isStreaming
      ? sanitizeAssistantVisibleText(rawContent)
      : rawContent
  );
  const displayReasoning = $derived(activeVersion?.reasoning || message.reasoning || '');
  const displayMetadata = $derived(activeVersion?.metadata || message.metadata || null);

  // The footer wants message-level usage overlaid with anything the active
  // version reported, so paging branches shows that branch's numbers.
  const footerMetadata = $derived.by(() => {
    const versionMeta = activeVersion?.metadata || null;
    const messageMeta = message.metadata || null;
    if (!versionMeta) return messageMeta;
    if (!messageMeta) return versionMeta;
    return { ...messageMeta, ...versionMeta };
  });

  /** Older messages predate `searchMeta`; reconstruct enough of it to render. */
  function inferSearchMeta(entry: ChatMessage): SearchMeta | null {
    if (!entry.sources?.length || entry.searchMode === 'chat') return null;
    return {
      searchRequested: true,
      searchSucceeded: true,
      contextAvailable: true,
      sourceCount: entry.sources.length,
      requestedProvider: appStore.config.search?.provider || 'aggregator',
      searchFallbackReason: '',
      providerWarnings: [],
      searchError: ''
    };
  }

  const displaySearchMeta = $derived(message.searchMeta || inferSearchMeta(message));

  const hasActiveDeepResearch = $derived(
    !!deepResearchStore.getActiveTaskForMessage(message.id)
  );

  const isEmpty = $derived(
    isAssistantMessageEmpty({
      message,
      displayContent,
      displayReasoning,
      displayMetadata,
      hasActiveDeepResearch
    })
  );

  // Getters, not a snapshot: `setContext` runs once but each read re-evaluates.
  const context: MessageContextValue = {
    get message() {
      return message;
    },
    get role() {
      return message.role;
    },
    get contextMode() {
      return contextMode;
    },
    get isStreaming() {
      return isStreaming;
    },
    get displayContent() {
      return displayContent;
    },
    get displayReasoning() {
      return displayReasoning;
    },
    get displayMetadata() {
      return displayMetadata;
    },
    get displaySearchMeta() {
      return displaySearchMeta;
    },
    get footerMetadata() {
      return footerMetadata;
    },
    get activeVersionIndex() {
      return activeVersionIndex;
    },
    get versionCount() {
      return versionCount;
    },
    get actionsPinned() {
      return forceActionsVisible || menuOpen;
    }
  };

  createMessageContext(context);
</script>

<!--
  The entry animation is skipped while streaming. It fades from opacity 0 and
  slides 12px over 600ms on mount — which for an assistant turn means it runs
  through the first ~35 content flushes, at the same time as the thread's
  scroll-to-bottom. Three motions competing for the first half-second of every
  answer read as jank. A streamed message is already announced by the typing
  indicator, so it just appears and starts filling in.
-->
<article
  class="group/msg flex flex-col {isStreaming ? '' : 'scroll-animate'} {message.role === 'user' ? 'items-end' : 'items-start'}"
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => {
    hovering = false;
    menuOpen = false;
  }}
>
  {#if message.role === 'user'}
    <UserMessage {hovering} onmenutoggle={(open) => (menuOpen = open)} />
  {:else if !isEmpty}
    <AssistantMessage {hovering} onmenutoggle={(open) => (menuOpen = open)} />
  {/if}
</article>
