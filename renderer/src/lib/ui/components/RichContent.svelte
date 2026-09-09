<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import type { ActionEvent } from '$lib/ui';
  import { renderMarkdown, observeLazyHighlight, splitStreamingMarkdown } from '$lib/utils/markdown';
  import { parseContentSegments, sanitizeAssistantArtifacts, stripChartBlocks } from '$lib/utils/charts';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
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

  /*
   * The character cap is the only pace-setter, and the frame callback is the only
   * clock. There used to be a second 26ms `performance.now()` gate here on top of
   * the store's 50ms `Date.now()` throttle; two unsynchronised throttles beating
   * against a 16.7ms frame budget is what made the reveal cadence look irregular.
   * 72 chars/frame is ~4300 chars/s — ahead of any model, so this smooths bursts
   * without ever becoming the bottleneck.
   */
  const STREAM_MAX_CHARS_PER_FLUSH = 72;

  let contentEl = $state<HTMLDivElement | undefined>(undefined);
  let displayedContent = $state(content);
  let pendingContent = $state(content);
  let renderRaf: number | undefined;
  let streamRenderMode = $state<'ui' | 'segments' | 'markdown' | null>(null);

  function flushRenderedContent() {
    if (displayedContent === pendingContent) return;
    if (pendingContent.startsWith(displayedContent)) {
      const delta = pendingContent.slice(displayedContent.length);
      displayedContent += delta.slice(0, STREAM_MAX_CHARS_PER_FLUSH);
    } else {
      displayedContent = pendingContent;
    }
  }

  function scheduleStreamingRender() {
    if (renderRaf !== undefined) return;
    const tick = () => {
      renderRaf = undefined;
      flushRenderedContent();
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
      if (displayedContent !== content) displayedContent = content;
      return;
    }

    scheduleStreamingRender();
  });

  const sanitizedContent = $derived(sanitizeAssistantArtifacts(displayedContent));
  const contentSegments = $derived(parseContentSegments(sanitizedContent));
  const hasCharts = $derived(contentSegments.some((segment) => segment.kind === 'chart'));
  const rendersUI = $derived(hasUIContent(sanitizedContent));
  const markdownSource = $derived(hasCharts ? stripChartBlocks(sanitizedContent) : sanitizedContent);

  /*
   * Split the message into a prefix whose DOM can be written once and a trailing
   * block that is still growing. `{@html}` as an element's only child compiles to
   * `innerHTML =`, which tears down and rebuilds every child on assignment — so a
   * single `{@html}` over the whole message re-created the entire subtree on every
   * flush. That is what restarted the old per-block entry animation (170ms) every
   * flush (26ms), leaving the trailing block pinned mid-fade and flickering.
   *
   * With the split, the settled prefix is written once per block boundary and left
   * alone; only the tail re-renders, and nothing is animated per flush.
   */
  const streamSplit = $derived.by(() => (
    status === 'streaming'
      ? splitStreamingMarkdown(markdownSource)
      : { settled: markdownSource, tail: '' }
  ));
  const settledHtml = $derived(streamSplit.settled ? renderMarkdown(streamSplit.settled) : '');
  const tailHtml = $derived(
    streamSplit.tail
      ? renderMarkdown(streamSplit.tail, { highlight: false, math: false, cache: false })
      : ''
  );

  const detectedRenderMode = $derived.by<'ui' | 'segments' | 'markdown'>(() => {
    if (rendersUI) return 'ui';
    if (hasCharts) return 'segments';
    return 'markdown';
  });
  const activeRenderMode = $derived(status === 'streaming' ? (streamRenderMode || detectedRenderMode) : detectedRenderMode);

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
          if (source && /^https?:/i.test(source.url)) {
            const chip = document.createElement('a');            chip.className = 'chateaui-pill mx-0.5 inline-flex h-5 min-w-5 items-center justify-center px-1.5 align-middle text-[11px] font-medium text-[var(--text-secondary)]';
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

  const readyForPostRender = $derived(status !== 'streaming' && markdownSource.length > 0);

  /*
   * Runs on the settled render, not per flush. It reads `settledHtml` so it re-runs
   * when the rendered DOM is replaced — previously it depended only on `contentEl`
   * and `sources`, and since sources arrive before the text in search mode it fired
   * once against a nearly-empty body and never again, leaving most citations
   * unconverted. Gating on `readyForPostRender` also keeps a full-subtree TreeWalker
   * off the streaming path.
   */
  $effect(() => {
    if (!contentEl || !sources?.length || activeRenderMode === 'ui') return;
    if (!readyForPostRender) return;
    void settledHtml;
    replaceCitations(contentEl, sources);
  });

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
    <div bind:this={contentEl} class="space-y-3">
      {#each contentSegments as segment}
        {#if segment.kind === 'text'}
          {#if segment.content.trim()}
            <div class="markdown-body markdown-segment" class:is-research={isResearch}>{@html renderMarkdown(segment.content)}</div>
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
    <!--
      Two `{@html}` blocks, not one: see `splitStreamingMarkdown`. `settledHtml`
      holds finished blocks and its DOM is stable between block boundaries;
      `tailHtml` holds the one block still arriving. `content-visibility: auto` is
      gone from both — it applies size containment off-screen, so a streaming
      message crossing the viewport edge repeatedly skipped and unskipped rendering.
    -->
    <div bind:this={contentEl} class="markdown-body" class:is-research={isResearch}>
      {#if settledHtml}<div class="stream-settled">{@html settledHtml}</div>{/if}
      {#if tailHtml}<div class="stream-tail" class:stream-caret={status === 'streaming'}>{@html tailHtml}</div>{/if}
    </div>
  {/if}
{/if}
