<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import type { ActionEvent } from '$lib/ui';
  import { renderMarkdown, observeLazyHighlight } from '$lib/utils/markdown';
  import { parseContentSegments, sanitizeAssistantArtifacts, stripChartBlocks } from '$lib/utils/charts';
  import ChartBlock from '$lib/components/chat/ChartBlock.svelte';
  import Renderer from '../Renderer.svelte';
  import { hasUIContent, uiChatLibrary } from '..';
  import { domainLabel } from '../message-utils';

  interface Props {
    content: string;
    status?: 'idle' | 'streaming' | 'error';
    metadataError?: boolean;
    sources?: ChatMessage['sources'];
    /** When set (search | deep | max), apply research-friendly APA report spacing. */
    searchMode?: ChatMessage['searchMode'] | null;
    onAction?: (event: ActionEvent) => void;
  }

  let { content, status = 'idle', metadataError = false, sources = [], searchMode = null, onAction }: Props = $props();

  const isResearch = $derived(
    searchMode === 'search' || searchMode === 'deep' || searchMode === 'max'
  );

  const STREAM_RENDER_DELAY = 26;
  const STREAM_MAX_CHARS_PER_FLUSH = 72;

  let contentEl = $state<HTMLDivElement | undefined>(undefined);
  let displayedContent = $state(content);
  let pendingContent = $state(content);
  let renderRaf: number | undefined;
  let lastFlushAt = $state(0);
  let isStreamingActive = $state(false);
  let streamRenderMode = $state<'ui' | 'segments' | 'markdown' | null>(null);

  function flushRenderedContent() {
    if (displayedContent !== pendingContent) {
      if (pendingContent.startsWith(displayedContent)) {
        const delta = pendingContent.slice(displayedContent.length);
        displayedContent += delta.slice(0, STREAM_MAX_CHARS_PER_FLUSH);
      } else {
        displayedContent = pendingContent;
      }
    }
    lastFlushAt = performance.now();
  }

  function scheduleStreamingRender() {
    if (renderRaf !== undefined) return;
    const tick = () => {
      renderRaf = undefined;
      const now = performance.now();
      if (now - lastFlushAt >= STREAM_RENDER_DELAY) {
        flushRenderedContent();
      }
      if (status === 'streaming' && displayedContent !== pendingContent) {
        renderRaf = requestAnimationFrame(tick);
      }
    };
    renderRaf = requestAnimationFrame(tick);
  }

  function clearStreamingRender() {
    if (renderRaf !== undefined) {
      cancelAnimationFrame(renderRaf);
      renderRaf = undefined;
    }
  }

  $effect(() => {
    pendingContent = content;

    if (status !== 'streaming') {
      clearStreamingRender();
      isStreamingActive = false;
      if (displayedContent !== content) displayedContent = content;
      return;
    }

    isStreamingActive = true;
    scheduleStreamingRender();
  });

  const sanitizedContent = $derived(sanitizeAssistantArtifacts(displayedContent));
  const contentSegments = $derived(parseContentSegments(sanitizedContent));
  const hasCharts = $derived(contentSegments.some((segment) => segment.kind === 'chart'));
  const rendersUI = $derived(hasUIContent(sanitizedContent));
  const markdownSource = $derived(hasCharts ? stripChartBlocks(sanitizedContent) : sanitizedContent);
  const markdownHtml = $derived(renderMarkdown(markdownSource));
  const detectedRenderMode = $derived.by<'ui' | 'segments' | 'markdown'>(() => {
    if (rendersUI) return 'ui';
    if (hasCharts) return 'segments';
    return 'markdown';
  });
  const activeRenderMode = $derived(status === 'streaming' ? (streamRenderMode || detectedRenderMode) : detectedRenderMode);
  const useStreamingEffects = $derived(status === 'streaming');

  $effect(() => {
    if (status === 'streaming') {
      if (!streamRenderMode) streamRenderMode = detectedRenderMode;
      return;
    }
    streamRenderMode = null;
  });

  function replaceCitations(container: HTMLElement, refs: NonNullable<ChatMessage['sources']>) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('a, code, pre')) continue;
      if (node.textContent?.includes('[')) textNodes.push(node as Text);
    }

    const citationRe = /\[(?:\()?(\d+)(?:\))?\](?:\s*\[(?:\()?(\d+)(?:\))?\])*|\[(?:\()?(\d+(?:\s*,\s*\d+)*)(?:\))?\]/g;
    for (const node of textNodes) {
      const text = node.textContent || '';
      if (!citationRe.test(text)) continue;
      citationRe.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null = null;
      while ((match = citationRe.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const numbers = match[0].match(/\d+/g) || [];
        for (const numberText of numbers) {
          const source = refs[Number(numberText) - 1];
          if (source) {
            const chip = document.createElement('a');
            chip.className = 'chateaui-pill mx-0.5 inline-flex h-5 min-w-5 items-center justify-center px-1.5 align-middle text-[11px] font-medium text-[var(--text-secondary)]';
            chip.href = source.url;
            chip.target = '_blank';
            chip.rel = 'noreferrer';
            chip.textContent = numberText;
            chip.title = `${source.title}\n${domainLabel(source.url)}`;
            fragment.appendChild(chip);
          } else {
            fragment.appendChild(document.createTextNode(`[${numberText}]`));
          }
        }
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      if (node.parentNode && lastIndex > 0) node.parentNode.replaceChild(fragment, node);
    }
  }

  $effect(() => {
    if (!contentEl || !sources?.length || activeRenderMode === 'ui') return;
    replaceCitations(contentEl, sources);
  });

  const readyForPostRender = $derived(status !== 'streaming' && markdownSource.length > 0);

  // Code-block copy buttons are emitted by the markdown renderer and handled by
  // a single delegated listener (see `utils/code-copy.ts`). This component used
  // to append a *second* button into every `<pre>`, so each block showed two.

  $effect(() => {
    if (!contentEl || activeRenderMode === 'ui' || !readyForPostRender) return;
    return observeLazyHighlight(contentEl);
  });
</script>

{#if status !== 'error' || (content && !metadataError)}
  {#if activeRenderMode === 'ui'}
    <Renderer response={sanitizedContent} library={uiChatLibrary} isStreaming={status === 'streaming'} onAction={onAction} />
  {:else if activeRenderMode === 'segments'}
    <div bind:this={contentEl} class="space-y-3" class:stream-caret={useStreamingEffects && !!content} class:streaming-active={isStreamingActive && useStreamingEffects}>
      {#each contentSegments as segment}
        {#if segment.kind === 'text'}
          {#if segment.content.trim()}
            <div class="markdown-body markdown-segment" class:is-research={isResearch} style="content-visibility: auto;">{@html renderMarkdown(segment.content)}</div>
          {/if}
        {:else}
          <ChartBlock
            type={segment.type}
            title={segment.title}
            xlabel={segment.xlabel}
            ylabel={segment.ylabel}
            raw={segment.raw}
          />
        {/if}
      {/each}
    </div>
  {:else if content}
    <div bind:this={contentEl} class="markdown-body" class:is-research={isResearch} class:stream-caret={useStreamingEffects && !!content} class:streaming-active={isStreamingActive && useStreamingEffects} style="content-visibility: auto;">{@html markdownHtml}</div>
  {/if}
{/if}

<style>
  :global(.streaming-active > .markdown-body > :last-child),
  :global(.streaming-active.markdown-body > :last-child),
  :global(.streaming-active > .markdown-segment:last-child) {
    animation: streamFadeIn 170ms ease-out;
  }

  @keyframes streamFadeIn {
    from { opacity: 0.78; }
    to { opacity: 1; }
  }
</style>
