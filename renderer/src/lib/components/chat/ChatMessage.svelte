<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { BriefcaseBusiness, ChevronLeft, ChevronRight, Check, Copy, CornerDownLeft, MoreHorizontal, Pencil, RefreshCcw, Trash2, Volume2, X } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { stripChartBlocks } from '$lib/utils/charts';
  import { sanitizeAssistantVisibleText } from '$lib/utils/assistant-visible';
  import { generatePptx } from '$lib/services/slides';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import TtsAudioPlayer from './TtsAudioPlayer.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import AssistantMessageBody from '$lib/ui/components/AssistantMessageBody.svelte';
  import AttachmentDocumentsBlock from './AttachmentDocumentsBlock.svelte';
  import FileChangesCard from '$lib/components/agent/FileChangesCard.svelte';
  import { buildUIActionMessage } from '$lib/ui';
  import type { ActionEvent } from '$lib/ui';
  import { APP_NAME } from '$lib/app-meta';

  interface Props {
    message: ChatMessage;
    forceActionsVisible?: boolean;
  }

  let { message, forceActionsVisible = false }: Props = $props();

  let hovering = $state(false);
  let copyFeedback = $state<string | null>(null);
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let actionMenuOpen = $state(false);

  const activeVersionIndex = $derived(typeof message.activeVersion === 'number' ? Math.max(0, Math.min(message.activeVersion, (message.versions?.length || 1) - 1)) : 0);
  const activeVersion = $derived(message.versions?.[activeVersionIndex] || null);
  const displayContent = $derived(
    message.role === 'assistant'
      ? (message.status === 'streaming'
          ? (activeVersion?.content || message.content || '')
          : sanitizeAssistantVisibleText(activeVersion?.content || message.content || ''))
      : (activeVersion?.content || message.content || '')
  );
  const displayReasoning = $derived(activeVersion?.reasoning || message.reasoning || '');
  const displayMetadata = $derived(activeVersion?.metadata || message.metadata || null);
  const footerMetadata = $derived.by(() => {
    const versionMeta = activeVersion?.metadata || null;
    const messageMeta = message.metadata || null;
    if (!versionMeta) return messageMeta;
    if (!messageMeta) return versionMeta;
    return {
      ...messageMeta,
      ...versionMeta
    };
  });
  const hasReliableUsage = $derived(footerMetadata?.usageSource === 'provider' || footerMetadata?.usageSource === 'runtime');
  const displayTokenCount = $derived(
    footerMetadata?.usageSource === 'runtime'
      ? (footerMetadata?.outputTokens || footerMetadata?.tokens || footerMetadata?.totalTokens || 0)
      : (footerMetadata?.outputTokens || footerMetadata?.totalTokens || footerMetadata?.tokens || 0)
  );
  const displayModelTiming = $derived.by(() => {
    if (!footerMetadata || !hasReliableUsage) return undefined;
    if (typeof footerMetadata.modelTimingSeconds === 'number') return footerMetadata.modelTimingSeconds;
    if (typeof footerMetadata.timing === 'number') return footerMetadata.timing;
    return undefined;
  });
  const footerBackendHint = $derived('');
  const displaySearchMeta = $derived(message.searchMeta || inferSearchMeta(message));
  const hasActiveDeepResearch = $derived.by(() => {
    return !!deepResearchStore.getActiveTaskForMessage(message.id);
  });
  const isAssistantVisiblyEmpty = $derived.by(() => {
    if (message.role !== 'assistant') return false;
    if (hasActiveDeepResearch) return false;
    if (message.status === 'streaming') return false;
    if ((displayContent || '').trim()) return false;
    if ((displayReasoning || '').trim()) return false;
    if (message.sources?.length) return false;
    if (message.slides?.length) return false;
    if (message.filesCreated?.length) return false;
    if (message.artifact) return false;
    if (displayMetadata?.error || displayMetadata?.warning) return false;
    return true;
  });
  const cleanContent = $derived(stripChartBlocks(displayContent));
  const diffStats = $derived(message.agentSteps?.flatMap((step) => step.diffStats || []) || []);

  function splitSelectedTextQuestion(content: string): { selectedText: string; question: string; sourceMessageId: string } | null {
    const raw = (content || '').trim();
    const sourceMatch = raw.match(/^<!--\s*chatealm-selected-source:([^\s]+)\s*-->\n?/);
    const sourceMessageId = sourceMatch?.[1] || '';
    const normalized = sourceMatch ? raw.slice(sourceMatch[0].length).trim() : raw;
    if (!normalized.startsWith('> ')) return null;

    const separatorIndex = normalized.indexOf('\n\n');
    if (separatorIndex < 0) return null;

    const quoteBlock = normalized.slice(0, separatorIndex);
    const question = normalized.slice(separatorIndex + 2).trim();
    if (!question) return null;

    const quoteLines = quoteBlock.split('\n');
    if (!quoteLines.every((line) => line.startsWith('>'))) return null;

    const selectedText = quoteLines
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim();

    return selectedText ? { selectedText, question, sourceMessageId } : null;
  }

  function scrollToSelectedSource() {
    const sourceMessageId = userSelectedTextQuestion?.sourceMessageId;
    if (!sourceMessageId) return;
    window.dispatchEvent(new CustomEvent('scroll-to-chat-message', { detail: { messageId: sourceMessageId } }));
  }

  const userSelectedTextQuestion = $derived(splitSelectedTextQuestion(message.content || ''));
  const userHtml = $derived(renderMarkdown(userSelectedTextQuestion?.question || message.content || ''));
  const userSelectedTextHtml = $derived(userSelectedTextQuestion ? renderMarkdown(userSelectedTextQuestion.selectedText) : '');

  // TTS state
  const isTtsGenerating = $derived(
    ttsStore.isGenerating && ttsStore.currentMessageId === message.id
  );
  const isTtsPlaying = $derived(
    ttsStore.playing && ttsStore.currentMessageId === message.id
  );
  const hasTtsAudio = $derived(
    ttsStore.hasStoredAudio(message.id) || !!message.ttsAudio
  );
  const hasActiveTtsPlayer = $derived(isTtsPlaying || hasTtsAudio);

  function inferSearchMeta(entry: ChatMessage): SearchMeta | null {
    if (!entry.sources?.length || entry.searchMode === 'chat') return null;
    return {
      searchRequested: true,
      searchSucceeded: true,
      contextAvailable: !!entry.sources.length,
      sourceCount: entry.sources.length,
      requestedProvider: appStore.config.search?.provider || 'aggregator',
      providerUsed: undefined,
      searchFallbackReason: '',
      providerWarnings: [],
      searchError: ''
    };
  }

  async function copyContent() {
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedback = null;
    requestAnimationFrame(() => {
      copyFeedback = 'copied';
    });
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback = null;
      copyFeedbackTimer = null;
    }, 1800);

    try {
      await navigator.clipboard.writeText(cleanContent || message.content || '');
    } catch {
      const text = cleanContent || message.content || '';
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
  }

  async function downloadSlides() {
    if (!message.slides?.length) return;
    const bytes = await generatePptx({
      title: message.slides[0]?.title || `${APP_NAME} Presentation`,
      slides: message.slides
    });
    const blob = new Blob([new Uint8Array(bytes)], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(message.slides[0]?.title || 'presentation').replace(/[^a-z0-9]+/gi, '_')}.pptx`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleUIAction(event: ActionEvent) {
    if (event.type === 'open_url') {
      const url = String(event.params?.url || '');
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    appStore.composer = buildUIActionMessage(event);
    await appStore.sendCurrentMessage();
  }

  function handleTtsAction() {
    if (isTtsGenerating) {
      // Stop generation
      ttsStore.stop();
      return;
    }
    if (isTtsPlaying) {
      // Stop playback
      ttsStore.stop();
      return;
    }
    // Always (re)generate audio — click again to regenerate
    const text = displayContent || '';
    if (!text.trim()) return;
    ttsStore.speak(message.id, text, appStore.config);
  }

  $effect(() => {
    const id = message.id;
    const handler = (msgId: string, dur: number) => {
      if (msgId === id && !message.ttsAudio) {
        message.ttsAudio = {
          duration: dur,
          voice: appStore.config.tts?.voice || 'af_heart',
          generatedAt: Date.now()
        };
        appStore.persist();
      }
    };
    ttsStore.onAudioComplete = handler;
    return () => {
      if (ttsStore.onAudioComplete === handler) ttsStore.onAudioComplete = null;
    };
  });
</script>

<article class={`group flex flex-col scroll-animate ${message.role === 'user' ? 'items-end' : 'items-start'}`} onmouseenter={() => (hovering = true)} onmouseleave={() => (hovering = false)}>
  {#if message.role === 'user'}
    {#if userSelectedTextQuestion}
      <button type="button" class="selected-text-message-bubble" data-chat-message-content data-chat-message-id={message.id} onclick={scrollToSelectedSource} title="Jump to original selection">
        <CornerDownLeft class="selected-text-message-icon h-4 w-4" />
        <div class="markdown-body user-markdown selected-text-message-markdown">{@html userSelectedTextHtml}</div>
      </button>
    {/if}
    <div class="user-message-stack max-w-[min(46rem,84%)] space-y-3">
      <div class="chateaui-user-bubble px-5 py-3.5 text-base leading-7 shadow-[var(--shadow-xs)]" data-chat-message-content data-chat-message-id={message.id}>
        <div class="markdown-body user-markdown">{@html userHtml}</div>
      </div>
      {#if message.attachments?.length}
        <div class="user-attachments-row">
          <AttachmentDocumentsBlock attachments={message.attachments} />
        </div>
      {/if}
      {#if message.workContext}
        <div class="flex flex-wrap justify-end gap-2">
          <div class="chateaui-pill inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-[color:var(--work-accent-strong)]" style="--chateaui-pill-border: var(--work-accent-border); --chateaui-pill-bg: var(--work-accent-soft);">
            <BriefcaseBusiness class="h-3 w-3" />
            Work · {message.workContext.rootName}
          </div>
          <div class="chateaui-pill inline-flex items-center px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {message.workContext.indexedCount} file{message.workContext.indexedCount === 1 ? '' : 's'}
          </div>
        </div>
      {/if}
      <div class={`message-action-bar justify-end ${hovering || forceActionsVisible || copyFeedback === 'copied' ? 'visible' : ''}`}>
          <button class="msg-action-btn" class:copied={copyFeedback === 'copied'} onclick={copyContent} aria-label="Copy message" title="Copy">
            {#if copyFeedback === 'copied'}
              <Check class="h-3.5 w-3.5" />
            {:else}
              <Copy class="h-3.5 w-3.5" />
            {/if}
          </button>
        <button class="msg-action-btn" onclick={() => appStore.openEditMessage(message.id)} aria-label="Edit message" title="Edit">
          <Pencil class="h-3.5 w-3.5 action-icon" />
        </button>
        <div class="msg-action-menu-wrap">
          <button class="msg-action-btn" onclick={() => (actionMenuOpen = !actionMenuOpen)} aria-label="More actions" title="More">
            <MoreHorizontal class="h-3.5 w-3.5 action-icon" />
          </button>
          {#if actionMenuOpen}
            <div class="msg-action-menu">
              <button class="msg-menu-item danger" onclick={() => { actionMenuOpen = false; confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) }); }}>
                <Trash2 class="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else if !isAssistantVisiblyEmpty}
    <div class="flex items-start gap-2 w-full max-w-full">
      <div class="flex-1 min-w-0">
      <div data-chat-message-content data-chat-message-id={message.id}>
        <AssistantMessageBody
          {message}
          {displayContent}
          {displayReasoning}
          {displayMetadata}
          {displaySearchMeta}
          enableThinking={!!appStore.config.ui?.enable_thinking}
          onDownloadSlides={downloadSlides}
          onOpenArtifact={() => appStore.openArtifact(message.artifact || null, message.id)}
          onUIAction={handleUIAction}
        />
      </div>

      {#if diffStats.length}
        <FileChangesCard stats={diffStats} />
      {/if}

      <!-- Model name + token usage (always visible) -->
      <div class="mt-1 flex items-center gap-2 flex-wrap">
        {#if hasReliableUsage && displayTokenCount}
          <span class="text-xs text-[var(--text-muted)]">
            {displayTokenCount} tok
            {#if displayModelTiming}· {displayModelTiming.toFixed(1)}s{/if}
            {#if footerMetadata?.tokensPerSecond}· {footerMetadata.tokensPerSecond.toFixed(0)}/s{/if}
          </span>
        {/if}
      </div>

      <!-- TTS player -->
      {#if hasActiveTtsPlayer && message.role === 'assistant' && message.status !== 'streaming' && appStore.config.tts?.enable_voice_output}
        <div class="mt-1"><TtsAudioPlayer {message} /></div>
      {/if}

      <!-- Action buttons + version nav (visible on hover) -->
      {#if !hasActiveDeepResearch}
      <div class="message-action-bar" class:visible={hovering || forceActionsVisible || copyFeedback === 'copied'}>
          {#if (message.versions?.length || 0) > 1}
            <button class="msg-action-btn" onclick={() => appStore.setMessageActiveVersion(message.id, -1)} aria-label="Previous version">
              <ChevronLeft class="h-3.5 w-3.5 action-icon" />
            </button>
            <span class="text-xs text-[var(--text-tertiary)]">{activeVersionIndex + 1}/{message.versions?.length || 1}</span>
            <button class="msg-action-btn" onclick={() => appStore.setMessageActiveVersion(message.id, 1)} aria-label="Next version">
              <ChevronRight class="h-3.5 w-3.5 action-icon" />
            </button>
          {/if}
          <button class="msg-action-btn" class:copied={copyFeedback === 'copied'} onclick={copyContent} aria-label="Copy response" title="Copy">
            {#if copyFeedback === 'copied'}
              <Check class="h-3.5 w-3.5" />
            {:else}
              <Copy class="h-3.5 w-3.5" />
            {/if}
          </button>
          {#if message.role === 'assistant' && message.status !== 'streaming' && appStore.config.tts?.enable_voice_output}
            <button class="msg-action-btn" onclick={handleTtsAction} aria-label="Read aloud" title={isTtsGenerating ? 'Stop generation' : isTtsPlaying ? 'Stop playback' : 'Listen'}>
              {#if isTtsGenerating || isTtsPlaying}
                <X class="h-3.5 w-3.5 action-icon" />
              {:else}
                <Volume2 class="h-3.5 w-3.5 action-icon" />
              {/if}
            </button>
          {/if}
          <button class="msg-action-btn" onclick={() => appStore.openEditMessage(message.id)} aria-label="Edit response" title="Edit">
            <Pencil class="h-3.5 w-3.5 action-icon" />
          </button>
          <button class="msg-action-btn" onclick={() => appStore.regenerateMessage(message.id)} disabled={appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun} aria-label="Retry" title="Retry">
            <RefreshCcw class="h-3.5 w-3.5 action-icon" />
          </button>
          <div class="msg-action-menu-wrap">
            <button class="msg-action-btn" onclick={() => (actionMenuOpen = !actionMenuOpen)} aria-label="More actions" title="More">
              <MoreHorizontal class="h-3.5 w-3.5 action-icon" />
            </button>
            {#if actionMenuOpen}
              <div class="msg-action-menu">
                <button class="msg-menu-item danger" onclick={() => { actionMenuOpen = false; confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) }); }}>
                  <Trash2 class="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      </div>
    </div>
  {/if}
</article>

<style>
  .msg-action-menu-wrap {
    position: relative;
    display: inline-flex;
  }

  .msg-action-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 30;
    min-width: 112px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }

  .msg-menu-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: 7px;
    padding: 7px 9px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    text-align: left;
  }

  .msg-menu-item:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .msg-menu-item.danger:hover {
    background: color-mix(in srgb, var(--error) 10%, transparent);
    color: var(--error);
  }

</style>
