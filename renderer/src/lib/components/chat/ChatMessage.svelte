<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { BriefcaseBusiness, ChevronLeft, ChevronRight, Copy, Pencil, RefreshCcw, Square, Trash2, Volume2, Wrench } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { stripChartBlocks } from '$lib/utils/charts';
  import { generatePptx } from '$lib/services/slides';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import AssistantMessageBody from '$lib/ui/components/AssistantMessageBody.svelte';
  import { buildUIActionMessage } from '$lib/ui';
  import type { ActionEvent } from '$lib/ui';

  interface Props {
    message: ChatMessage;
  }

  let { message }: Props = $props();

  let hovering = $state(false);

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
  // For copy / TTS — strip chart JSON blobs
  const cleanContent = $derived(stripChartBlocks(displayContent));
  const userHtml = $derived(renderMarkdown(message.content || ''));

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
  }

  function speakContent() {
    if (ttsStore.isSpeaking(message.id)) {
      ttsStore.stop();
      return;
    }
    if (!cleanContent) return;
    ttsStore.speak(message.id, cleanContent, appStore.config);
  }

  async function downloadSlides() {
    if (!message.slides?.length) return;
    const bytes = await generatePptx({
      title: message.slides[0]?.title || 'TalamoLM Presentation',
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

  function toolCallingState() {
    if (message.mode === 'agent' && message.agentSteps?.length) return 'active';
    return null;
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
</script>

<article class={`group flex flex-col scroll-animate ${message.role === 'user' ? 'items-end' : 'items-start'}`} onmouseenter={() => (hovering = true)} onmouseleave={() => (hovering = false)}>
  {#if message.role === 'user'}
    <div class="max-w-[min(46rem,84%)] space-y-3">
      <div class="openui-user-bubble px-5 py-3.5 text-base leading-7">
        <div class="markdown-body user-markdown">{@html userHtml}</div>
      </div>
      {#if message.attachments?.length}
        <div class="flex flex-wrap justify-end gap-2 mb-1">
          {#each message.attachments as attachment (attachment.id)}
            {#if attachment.kind === 'image' && (attachment.preview || attachment.base64)}
              <!-- Image as standalone thumbnail -->
              <img
                src={attachment.preview || attachment.base64}
                alt={attachment.name}
                class="max-h-48 max-w-[280px] rounded-2xl border border-[var(--border)] object-cover"
                title={attachment.name}
              />
            {:else}
              <!-- Document chip -->
              <div class="openui-card inline-flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)]">
                <span class="truncate max-w-[12rem] font-medium">{attachment.name}</span>
                <span class="text-[11px] text-[var(--text-muted)]">{attachment.status === 'error' ? 'Failed' : 'Indexed'}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if message.workContext}
        <div class="flex flex-wrap justify-end gap-2">
          <div class="openui-pill inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-[color:var(--work-accent-strong)]" style="--openui-pill-border: var(--work-accent-border); --openui-pill-bg: var(--work-accent-soft);">
            <BriefcaseBusiness class="h-3 w-3" />
            Work · {message.workContext.rootName}
          </div>
          <div class="openui-pill inline-flex items-center px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {message.workContext.indexedCount} file{message.workContext.indexedCount === 1 ? '' : 's'}
          </div>
        </div>
      {/if}
      <div class={`flex justify-end gap-0.5 text-fg-muted transition-opacity duration-200 ${hovering ? 'visible opacity-100' : 'invisible opacity-0'}`}>
          <button class="openui-icon-button rounded-lg p-1.5" onclick={copyContent} aria-label="Copy message">
            <Copy class="h-3.5 w-3.5" />
          </button>
        <button class="openui-icon-button rounded-lg p-1.5" onclick={() => appStore.openEditMessage(message.id)} aria-label="Edit message">
          <Pencil class="h-3.5 w-3.5" />
        </button>
        <button class="openui-icon-button rounded-lg p-1.5" style="--openui-icon-button-hover-color: var(--error); --openui-icon-button-hover-bg: color-mix(in srgb, var(--error) 8%, transparent);" onclick={() => confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) })} aria-label="Delete message">
          <Trash2 class="h-3.5 w-3.5" />
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

      {#if message.status !== 'streaming' && (displayMetadata || message.model || toolCallingState())}
        <!-- Model name shown subtly below content -->
        <div class="mt-2 text-[12px] text-[var(--text-muted)]">
          {displayMetadata?.modelName || message.model || ''}
          {#if toolCallingState()}
            <span class="ml-1 inline-flex items-center gap-0.5"><Wrench class="inline h-3 w-3" /> Tools</span>
          {/if}
        </div>
      {/if}

      {#if (message.versions?.length || 0) > 1}
        <div class="openui-pill mt-3 inline-flex items-center gap-2 px-2 py-1 text-xs text-[var(--text-tertiary)]">
          <button class="openui-icon-button rounded-full p-1" onclick={() => appStore.setMessageActiveVersion(message.id, -1)} aria-label="Previous version">
            <ChevronLeft class="h-3.5 w-3.5" />
          </button>
          <span>{activeVersionIndex + 1}/{message.versions?.length || 1}</span>
          <button class="openui-icon-button rounded-full p-1" onclick={() => appStore.setMessageActiveVersion(message.id, 1)} aria-label="Next version">
            <ChevronRight class="h-3.5 w-3.5" />
          </button>
        </div>
      {/if}

      <div class={`mt-2 flex items-center gap-0.5 text-fg-muted transition-opacity duration-200 ${hovering ? 'visible opacity-100' : 'invisible opacity-0'}`}>
          {#if displayMetadata?.tokens}
            <span class="openui-pill mr-1 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
              {displayMetadata.tokens} tok
              {#if displayMetadata.timing}· {displayMetadata.timing.toFixed(1)}s{/if}
              {#if displayMetadata.tokensPerSecond}· {displayMetadata.tokensPerSecond.toFixed(0)}/s{/if}
            </span>
          {/if}
          <button class="openui-icon-button rounded-lg p-1.5" onclick={copyContent} aria-label="Copy response" title="Copy">
            <Copy class="h-3.5 w-3.5" />
          </button>
          <button class="openui-icon-button rounded-lg p-1.5" onclick={() => appStore.openEditMessage(message.id)} aria-label="Edit response" title="Edit">
            <Pencil class="h-3.5 w-3.5" />
          </button>
          <button
            class="openui-icon-button rounded-lg p-1.5"
            style={ttsStore.isSpeaking(message.id) ? '--openui-icon-button-color: var(--primary); --openui-icon-button-bg: var(--surface-highlight); --openui-icon-button-border: var(--border-light);' : ''}
            onclick={speakContent}
            aria-label={ttsStore.isSpeaking(message.id) ? 'Stop reading' : 'Read aloud'}
            title={ttsStore.isSpeaking(message.id) ? 'Stop' : 'Read aloud'}
          >
            {#if ttsStore.isSpeaking(message.id)}
              <Square class="h-3.5 w-3.5" />
            {:else}
              <Volume2 class="h-3.5 w-3.5" />
            {/if}
          </button>
          <button class="openui-icon-button rounded-lg p-1.5 disabled:opacity-40" onclick={() => appStore.regenerateMessage(message.id)} disabled={appStore.loading} aria-label="Retry" title="Retry">
            <RefreshCcw class="h-3.5 w-3.5" />
          </button>
          <button class="openui-icon-button rounded-lg p-1.5" style="--openui-icon-button-hover-color: var(--error); --openui-icon-button-hover-bg: color-mix(in srgb, var(--error) 8%, transparent);" onclick={() => confirmStore.show({ title: 'Delete Message?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteMessage(message.id) })} aria-label="Delete" title="Delete">
            <Trash2 class="h-3.5 w-3.5" />
          </button>
      </div>
      </div>
    </div>
  {/if}
</article>
