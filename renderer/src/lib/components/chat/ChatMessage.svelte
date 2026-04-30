<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { BriefcaseBusiness, ChevronLeft, ChevronRight, Check, Copy, Pencil, RefreshCcw, Trash2, Wrench, Volume2, X } from 'lucide-svelte';
  
  import { renderMarkdown } from '$lib/utils/markdown';
  import { stripChartBlocks } from '$lib/utils/charts';
  import { generatePptx } from '$lib/services/slides';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import TtsAudioPlayer from './TtsAudioPlayer.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import AssistantMessageBody from '$lib/ui/components/AssistantMessageBody.svelte';
  import { buildUIActionMessage } from '$lib/ui';
  import type { ActionEvent } from '$lib/ui';
  import { APP_NAME } from '$lib/app-meta';

  interface Props {
    message: ChatMessage;
  }

  let { message }: Props = $props();

  let hovering = $state(false);
  let copyFeedback = $state<string | null>(null);
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  const activeVersionIndex = $derived(typeof message.activeVersion === 'number' ? Math.max(0, Math.min(message.activeVersion, (message.versions?.length || 1) - 1)) : 0);
  const activeVersion = $derived(message.versions?.[activeVersionIndex] || null);
  const displayContent = $derived(activeVersion?.content || message.content || '');
  const displayReasoning = $derived(activeVersion?.reasoning || message.reasoning || '');
  const displayMetadata = $derived(activeVersion?.metadata || message.metadata || null);
  const displaySearchMeta = $derived(message.searchMeta || inferSearchMeta(message));
  const hasActiveDeepResearch = $derived.by(() => {
    const task = deepResearchStore.activeTask;
    return !!task && task.messageId === message.id;
  });
  const cleanContent = $derived(stripChartBlocks(displayContent));
  const userHtml = $derived(renderMarkdown(message.content || ''));

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
  const hasActiveTtsPlayer = $derived(isTtsGenerating || isTtsPlaying || hasTtsAudio);

  function inferSearchMeta(entry: ChatMessage): SearchMeta | null {
    if (!entry.sources?.length || entry.searchMode === 'chat') return null;
    return {
      searchRequested: true,
      searchSucceeded: true,
      contextAvailable: !!entry.sources.length,
      sourceCount: entry.sources.length,
      requestedProvider: appStore.config.search?.provider || 'auto',
      providerUsed: undefined,
      searchFallbackReason: '',
      providerWarnings: [],
      searchError: ''
    };
  }

  async function copyContent() {
    await navigator.clipboard.writeText(cleanContent || message.content || '');
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedback = 'copied';
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback = null;
      copyFeedbackTimer = null;
    }, 1800);
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
    const text = message.content || '';
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
    <div class="max-w-[min(46rem,84%)] space-y-3">
      <div class="chateaui-user-bubble px-5 py-3.5 text-base leading-7 shadow-[var(--shadow-xs)]">
        <div class="markdown-body user-markdown">{@html userHtml}</div>
      </div>
      {#if message.attachments?.length}
        <div class="flex flex-wrap justify-end gap-2 mb-1">
          {#each message.attachments as attachment (attachment.id)}
            {#if attachment.kind === 'image' && (attachment.preview || attachment.base64)}
              <img
                src={attachment.base64 || attachment.preview}
                alt={attachment.name}
                class="max-h-48 max-w-[280px] rounded-2xl border border-[var(--border)] object-cover"
                title={attachment.name}
              />
            {:else}
              <div class="chateaui-card inline-flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)]">
                <span class="truncate max-w-[12rem] font-medium">{attachment.name}</span>
                <span class="text-[11px] text-[var(--text-muted)]">{attachment.status === 'error' ? 'Failed' : 'Indexed'}</span>
              </div>
            {/if}
          {/each}
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
      <div class={`message-action-bar justify-end ${hovering ? 'visible' : ''}`}>
          <button class="msg-action-btn" onclick={copyContent} aria-label="Copy message" title="Copy">
            {#if copyFeedback === 'copied'}
              <Check class="h-3.5 w-3.5 action-icon copied" />
            {:else}
              <Copy class="h-3.5 w-3.5 action-icon" />
            {/if}
          </button>
        <button class="msg-action-btn" onclick={() => appStore.openEditMessage(message.id)} aria-label="Edit message" title="Edit">
          <Pencil class="h-3.5 w-3.5 action-icon" />
        </button>
        <button class="msg-action-btn danger" style="--chateaui-icon-button-hover-color: var(--error); --chateaui-icon-button-hover-bg: color-mix(in srgb, var(--error) 8%, transparent);" onclick={() => confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) })} aria-label="Delete message" title="Delete">
          <Trash2 class="h-3.5 w-3.5 action-icon" />
        </button>
      </div>
    </div>
  {:else}
    <div class="flex items-start gap-2 w-full max-w-full">
      <div class="flex-1 min-w-0">
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

      <!-- Model name + token usage (always visible) -->
      <div class="mt-1 flex items-center gap-2 flex-wrap">
        {#if message.status !== 'streaming' && (displayMetadata?.modelName || message.model)}
          <span class="text-xs text-[var(--text-muted)]">{displayMetadata?.modelName || message.model}</span>
        {/if}
        {#if displayMetadata?.tokens}
          <span class="text-xs text-[var(--text-muted)]">
            {displayMetadata.tokens} tok
            {#if displayMetadata.timing}· {displayMetadata.timing.toFixed(1)}s{/if}
            {#if displayMetadata.tokensPerSecond}· {displayMetadata.tokensPerSecond.toFixed(0)}/s{/if}
          </span>
        {/if}
      </div>

      <!-- TTS player -->
      {#if hasActiveTtsPlayer && message.role === 'assistant' && message.status !== 'streaming' && appStore.config.tts?.enable_voice_output}
        <div class="mt-1"><TtsAudioPlayer {message} /></div>
      {/if}

      <!-- Action buttons + version nav (visible on hover) -->
      <div class="message-action-bar" class:visible={hovering}>
          {#if (message.versions?.length || 0) > 1}
            <button class="msg-action-btn" onclick={() => appStore.setMessageActiveVersion(message.id, -1)} aria-label="Previous version">
              <ChevronLeft class="h-3.5 w-3.5 action-icon" />
            </button>
            <span class="text-xs text-[var(--text-tertiary)]">{activeVersionIndex + 1}/{message.versions?.length || 1}</span>
            <button class="msg-action-btn" onclick={() => appStore.setMessageActiveVersion(message.id, 1)} aria-label="Next version">
              <ChevronRight class="h-3.5 w-3.5 action-icon" />
            </button>
          {/if}
          <button class="msg-action-btn" onclick={copyContent} aria-label="Copy response" title="Copy">
            {#if copyFeedback === 'copied'}
              <Check class="h-3.5 w-3.5 action-icon copied" />
            {:else}
              <Copy class="h-3.5 w-3.5 action-icon" />
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
          <button class="msg-action-btn" onclick={() => appStore.regenerateMessage(message.id)} disabled={appStore.loading} aria-label="Retry" title="Retry">
            <RefreshCcw class="h-3.5 w-3.5 action-icon" />
          </button>
          <button class="msg-action-btn danger" style="--chateaui-icon-button-hover-color: var(--error); --chateaui-icon-button-hover-bg: color-mix(in srgb, var(--error) 8%, transparent);" onclick={() => confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) })} aria-label="Delete" title="Delete">
            <Trash2 class="h-3.5 w-3.5 action-icon" />
          </button>
        </div>
      </div>
    </div>
  {/if}
</article>
