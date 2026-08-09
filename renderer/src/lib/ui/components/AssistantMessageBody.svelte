<svelte:options runes={true} />

<script lang="ts">
  import type { ChatContextMode, ChatMessage, MessageVersion, SearchMeta } from '$lib/types/chat';
  import type { ActionEvent } from '$lib/ui';
  import { AlertCircle } from 'lucide-svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import DeepResearchWidget from '$lib/components/search/DeepResearchWidget.svelte';
  import AgentBlock from './AgentBlock.svelte';
  import ReasoningBlock from './ReasoningBlock.svelte';
  import SourcesBlock from './SourcesBlock.svelte';
  import ResearchExportBar from './ResearchExportBar.svelte';
  import SearchStatusBlock from './SearchStatusBlock.svelte';
  import ContextBadges from './ContextBadges.svelte';
  import RichContent from './RichContent.svelte';
  import SlidesBlock from './SlidesBlock.svelte';
  import FilesCreatedBlock from './FilesCreatedBlock.svelte';
  import ArtifactBlock from './ArtifactBlock.svelte';
  import DocumentSurface from '$lib/components/chat/DocumentSurface.svelte';
  import type { DocumentSurfaceItem } from '$lib/components/chat/document-surface';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';


  interface Props {
    message: ChatMessage;
    displayContent: string;
    displayReasoning: string;
    displayMetadata: MessageVersion['metadata'] | null;
    displaySearchMeta: SearchMeta | null;
    contextMode?: ChatContextMode;
    enableThinking: boolean;
    onDownloadSlides: () => void;
    onOpenArtifact: () => void;
    onUIAction: (event: ActionEvent) => void;
  }

  let {
    message,
    displayContent,
    displayReasoning,
    displayMetadata,
    displaySearchMeta,
    contextMode = 'chat',
    enableThinking,
    onDownloadSlides,
    onOpenArtifact,
    onUIAction
  }: Props = $props();

  const hasActiveDeepResearch = $derived.by(() => {
    return !!deepResearchStore.getActiveTaskForMessage(message.id);
  });

  const hasSources = $derived((message.sources?.length || 0) > 0);
  const hasSearchStatus = $derived(
    !!displaySearchMeta && (
      !!displaySearchMeta.searchError ||
      !!displaySearchMeta.searchFallbackReason ||
      !!displaySearchMeta.providerWarnings?.length ||
      !!displaySearchMeta.researchSummary ||
      (!hasSources && !!displaySearchMeta.searchRequested)
    )
  );

  const displayWorkContext = $derived(message.workContext);
  const hasContextBadges = $derived(!!displayWorkContext || (message.ragDocuments?.length || 0) > 0);

  function cleanReportTitle(value: string) {
    return String(value || '')
      .replace(/^#+\s*/, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  }

  const isReportSurface = $derived(
    !!displayContent
    && displayMetadata?.documentSurface?.kind === 'report'
    && message.status !== 'error'
  );
  const reportTitle = $derived(cleanReportTitle(displayMetadata?.documentSurface?.title || (displayContent.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || 'Document')));
  const reportDocs = $derived.by((): DocumentSurfaceItem[] => {
    if (!isReportSurface) return [];
    return [{
      id: `${message.id}:report`,
      name: `${reportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document'}.md`,
      title: reportTitle,
      content: displayContent,
      kind: 'report',
      status: displayMetadata?.workProduct?.status || 'ready'
    }];
  });
  const hasDocumentArtifact = $derived(!!message.artifact && resolveArtifactPresentation(message.artifact).manifest.presentation === 'document');
  const visibleContent = $derived(displayContent);
  const showSourcesBlock = $derived.by(() => {
    if (!hasSources) return false;
    return true;
  });
  const showSearchStatus = $derived(hasSearchStatus);

  function resolveTotalElapsed(metadata: MessageVersion['metadata'] | null | undefined) {
    if (!metadata) return undefined;
    if (typeof metadata.totalElapsedSeconds === 'number') return metadata.totalElapsedSeconds;
    if ((message.mode === 'agent' || metadata.outcome === 'partial' || metadata.outcome === 'stopped') && typeof metadata.timing === 'number') {
      return metadata.timing;
    }
    return undefined;
  }

  function resolveReasoningTiming(metadata: MessageVersion['metadata'] | null | undefined) {
    if (!metadata) return undefined;
    if (typeof metadata.reasoningTimingSeconds === 'number') return metadata.reasoningTimingSeconds;
    return undefined;
  }

  function resolveDisplayTotalElapsed(metadata: MessageVersion['metadata'] | null | undefined) {
    const isAgentRun = message.mode === 'agent'
      || !!message.agentSteps?.length
      || metadata?.outcome === 'partial'
      || metadata?.outcome === 'stopped';
    if (!isAgentRun) return undefined;
    const total = resolveTotalElapsed(metadata);
    const reasoning = resolveReasoningTiming(metadata);
    if (typeof total !== 'number' || total <= 0) return undefined;
    if (typeof reasoning === 'number' && reasoning > 0 && Math.abs(total - reasoning) < 0.25) return undefined;
    return total;
  }
</script>

{#if hasActiveDeepResearch}
  <DeepResearchWidget messageId={message.id} />
{/if}

<!-- Chain-of-thought stack (assistant-ui): reasoning → tools → then answer below -->
<div class="aui-cot-stack mb-1 w-full">
  {#if enableThinking && displayReasoning}
    <ReasoningBlock
      reasoning={displayReasoning}
      status={message.status}
      timing={resolveReasoningTiming(displayMetadata) || 0}
      totalElapsedSeconds={resolveDisplayTotalElapsed(displayMetadata)}
      variant="outline"
    />
  {/if}

  {#if message.agentSteps?.length || (message.mode === 'agent' && message.status === 'streaming' && !displayContent && !hasActiveDeepResearch)}
    <!-- Single status line; full tool list lives in the activity drawer -->
    <AgentBlock
      steps={message.agentSteps || []}
      reasoning={enableThinking ? displayReasoning : undefined}
      status={message.status}
      totalElapsedSeconds={resolveTotalElapsed(displayMetadata)}
      outcome={displayMetadata?.outcome}
      stopReason={displayMetadata?.stopReason || displaySearchMeta?.stopReason}
      currentActivity={displayMetadata?.currentActivity}
      activityLabel={displayMetadata?.activityLabel}
      sourceCount={message.sources?.length || 0}
      messageId={message.id}
      searchMode={message.searchMode || null}
    />
  {/if}
</div>

{#if hasContextBadges}
  <ContextBadges workContext={displayWorkContext} sourceCount={0} ragCount={message.ragDocuments?.length || 0} />
{/if}

{#if message.status === 'error' && displayMetadata?.error}
  <div class="mb-3 flex items-start gap-2.5 rounded-lg bg-error-bg px-4 py-3 text-sm text-error">
    <AlertCircle class="mt-0.5 size-4 shrink-0" />
    <div>
      <div class="font-semibold text-foreground">Generation failed</div>
      {#if displayMetadata?.errorMessage}
        <div class="mt-0.5 text-xs opacity-80">{displayMetadata.errorMessage}</div>
      {:else if displayContent}
        <div class="mt-0.5 text-xs opacity-80">{displayContent}</div>
      {/if}
    </div>
  </div>
{:else if displayMetadata?.warning && !visibleContent && (displayMetadata?.outcome === 'partial' || displayMetadata?.outcome === 'stopped')}
  <div class="mb-2 text-xs text-[var(--text-muted)]">
    {displayMetadata.warning}
  </div>
{/if}

{#if message.status === 'streaming' && !visibleContent && !displayReasoning && !message.agentSteps?.length && !hasActiveDeepResearch}
  <div class="my-2 flex items-center gap-1">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>
{/if}

{#if visibleContent}
  <RichContent content={visibleContent} status={message.status} metadataError={!!displayMetadata?.error} sources={message.sources} searchMode={message.searchMode || null} onAction={onUIAction} />
{/if}

{#if reportDocs.length && !hasDocumentArtifact}
  <!-- SourcesBlock below owns the source count — avoid repeating "N sources" here -->
  <DocumentSurface docs={reportDocs} title={reportTitle} sourceCount={0} allowDownload={false} />
{/if}

<!-- Research chrome after the answer: sources, optional collapsible brief -->
{#if showSourcesBlock}
  <SourcesBlock sources={message.sources} searchMode={message.searchMode} meta={displaySearchMeta} messageId={message.id} />
  <!-- Quiet file downloads for Deep/Max only — primary visual widgets are chart-style inline artifacts -->
  {#if message.searchMode === 'deep' || message.searchMode === 'max'}
    <ResearchExportBar
      sources={message.sources}
      searchMode={message.searchMode}
      meta={displaySearchMeta}
      title={message.content?.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') || 'Research'}
    />
  {/if}
{/if}

{#if showSearchStatus}
  <SearchStatusBlock
    meta={displaySearchMeta}
    hasAnswer={!!visibleContent?.trim()}
    hasSources={hasSources}
  />
{/if}

<SlidesBlock slides={message.slides} mode={message.mode} onDownload={onDownloadSlides} />
<FilesCreatedBlock files={message.filesCreated || []} />
<ArtifactBlock artifact={message.artifact} onOpen={onOpenArtifact} />

