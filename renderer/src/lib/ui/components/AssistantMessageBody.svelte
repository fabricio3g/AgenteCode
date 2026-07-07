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
  import SearchStatusBlock from './SearchStatusBlock.svelte';
  import ContextBadges from './ContextBadges.svelte';
  import RichContent from './RichContent.svelte';
  import SlidesBlock from './SlidesBlock.svelte';
  import FilesCreatedBlock from './FilesCreatedBlock.svelte';
  import ArtifactBlock from './ArtifactBlock.svelte';
  import DocumentSurface from '$lib/components/chat/DocumentSurface.svelte';
  import InlineAgentSteps from '$lib/components/agent/InlineAgentSteps.svelte';
  import { isPublicFallbackContent } from '$lib/services/agent-parsing';
  import type { DocumentSurfaceItem } from '$lib/components/chat/document-surface';


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

  const displayWorkContext = $derived(contextMode === 'code' ? null : message.workContext);
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
  const visibleContent = $derived(
    contextMode === 'code' && isPublicFallbackContent(displayContent)
      ? ''
      : displayContent
  );
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

{#if message.agentSteps?.length || (message.mode === 'agent' && message.status === 'streaming' && !displayContent && !hasActiveDeepResearch)}
  {#if contextMode === 'code'}
    {#if enableThinking && displayReasoning}
      <ReasoningBlock
        reasoning={displayReasoning}
        status={message.status}
        timing={resolveReasoningTiming(displayMetadata) || 0}
        totalElapsedSeconds={resolveDisplayTotalElapsed(displayMetadata)}
      />
    {/if}
    <InlineAgentSteps
      steps={message.agentSteps || []}
      status={message.status}
      totalElapsedSeconds={resolveTotalElapsed(displayMetadata)}
    />
  {:else}
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
    />
    {#if message.agentSteps?.length}
      <InlineAgentSteps steps={message.agentSteps} status={message.status} />
    {/if}
  {/if}
{/if}

{#if showSourcesBlock}
  <SourcesBlock sources={message.sources} searchMode={message.searchMode} meta={displaySearchMeta} messageId={message.id} />
{/if}

{#if showSearchStatus}
  <SearchStatusBlock meta={displaySearchMeta} />
{/if}

{#if hasContextBadges}
  <ContextBadges workContext={displayWorkContext} sourceCount={0} ragCount={message.ragDocuments?.length || 0} />
{/if}

{#if enableThinking && displayReasoning && !message.agentSteps?.length}
  <ReasoningBlock
    reasoning={displayReasoning}
    status={message.status}
    timing={resolveReasoningTiming(displayMetadata) || 0}
    totalElapsedSeconds={resolveDisplayTotalElapsed(displayMetadata)}
  />
{/if}

{#if message.status === 'error' && displayMetadata?.error}
  <div class="chateaui-card mb-3 flex items-start gap-2.5 px-4 py-3 text-sm" style="--chateaui-card-bg: color-mix(in srgb, var(--error) 8%, var(--surface)); --chateaui-card-border: color-mix(in srgb, var(--error) 24%, var(--border));">
    <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-error" />
    <div>
      <div class="font-semibold">Generation failed</div>
      {#if displayMetadata?.errorMessage}
        <div class="mt-0.5 text-xs text-error opacity-70">{displayMetadata.errorMessage}</div>
      {:else if displayContent}
        <div class="mt-0.5 text-xs text-error opacity-70">{displayContent}</div>
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
  <RichContent content={visibleContent} status={message.status} metadataError={!!displayMetadata?.error} sources={message.sources} onAction={onUIAction} />
{/if}

{#if reportDocs.length}
  <DocumentSurface docs={reportDocs} title={reportTitle} sourceCount={message.sources?.length || 0} allowDownload={false} />
{/if}

<SlidesBlock slides={message.slides} mode={message.mode} onDownload={onDownloadSlides} />
<FilesCreatedBlock files={message.filesCreated || []} />
<ArtifactBlock artifact={message.artifact} onOpen={onOpenArtifact} />

