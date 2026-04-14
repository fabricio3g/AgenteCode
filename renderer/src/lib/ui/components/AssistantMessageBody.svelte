<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, MessageVersion, SearchMeta } from '$lib/types/chat';
  import type { ActionEvent } from '$lib/ui';
  import { AlertCircle } from 'lucide-svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import DeepResearchWidget from '$lib/components/search/DeepResearchWidget.svelte';
  import MorphingHexagon from './MorphingHexagon.svelte';
  import AgentRuntimeBlock from './AgentRuntimeBlock.svelte';
  import AgentTimeline from './AgentTimeline.svelte';
  import SourcesBlock from './SourcesBlock.svelte';
  import SearchStatusBlock from './SearchStatusBlock.svelte';
  import ContextBadges from './ContextBadges.svelte';
  import ReasoningBlock from './ReasoningBlock.svelte';
  import RichContent from './RichContent.svelte';
  import SlidesBlock from './SlidesBlock.svelte';
  import FilesCreatedBlock from './FilesCreatedBlock.svelte';
  import ArtifactBlock from './ArtifactBlock.svelte';

  interface Props {
    message: ChatMessage;
    displayContent: string;
    displayReasoning: string;
    displayMetadata: MessageVersion['metadata'] | null;
    displaySearchMeta: SearchMeta | null;
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
    enableThinking,
    onDownloadSlides,
    onOpenArtifact,
    onUIAction
  }: Props = $props();

  const hasActiveDeepResearch = $derived.by(() => {
    const task = deepResearchStore.activeTask;
    return !!task && task.messageId === message.id;
  });

  const hasAgentRuntime = $derived(
    message.mode === 'agent' ||
    message.status === 'streaming' ||
    !!message.agentTaskId ||
    !!message.agentSteps?.length ||
    !!message.artifact ||
    !!message.workContext
  );

  const hasSources = $derived((message.sources?.length || 0) > 0);
  const hasSearchStatus = $derived(
    !!displaySearchMeta && (
      !!displaySearchMeta.searchRequested ||
      !!displaySearchMeta.searchError ||
      !!displaySearchMeta.searchFallbackReason ||
      !!displaySearchMeta.providerWarnings?.length
    )
  );

  const hasContextBadges = $derived(!!message.workContext || (message.ragDocuments?.length || 0) > 0);
</script>

{#if hasActiveDeepResearch}
  <DeepResearchWidget messageId={message.id} />
{/if}

{#if hasAgentRuntime}
  <AgentRuntimeBlock
    mode={message.mode}
    messageStatus={message.status}
    agentTaskId={message.agentTaskId}
    stepCount={message.agentSteps?.length || 0}
    hasArtifact={!!message.artifact}
    workspaceBound={!!message.workContext}
  />
{/if}

{#if message.agentSteps?.length}
  <AgentTimeline steps={message.agentSteps} managed={!!message.agentTaskId} />
{/if}

{#if hasSources}
  <SourcesBlock sources={message.sources} searchMode={message.searchMode} meta={displaySearchMeta} />
{/if}

{#if hasSearchStatus}
  <SearchStatusBlock meta={displaySearchMeta} />
{/if}

{#if hasContextBadges}
  <ContextBadges workContext={message.workContext} sourceCount={0} ragCount={message.ragDocuments?.length || 0} />
{/if}

{#if enableThinking && displayReasoning}
  <ReasoningBlock reasoning={displayReasoning} status={message.status} timing={displayMetadata?.timing || 0} />
{/if}

{#if message.status === 'error'}
  <div class="openui-card mb-3 flex items-start gap-2.5 px-4 py-3 text-sm" style="--openui-card-bg: color-mix(in srgb, var(--error) 8%, var(--surface)); --openui-card-border: color-mix(in srgb, var(--error) 24%, var(--border));">
    <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-error" />
    <div>
      <div class="font-semibold">Generation failed</div>
      {#if displayContent && displayMetadata?.error}
        <div class="mt-0.5 text-xs text-error opacity-70">{displayContent}</div>
      {/if}
    </div>
  </div>
{/if}

<RichContent content={displayContent} status={message.status} metadataError={!!displayMetadata?.error} sources={message.sources} onAction={onUIAction} />

{#if message.status === 'streaming' && !displayContent && !displayReasoning && !message.agentSteps?.length}
  {#if !hasActiveDeepResearch}
    <div class="thinking-indicator flex items-center gap-2.5 py-2">
      <MorphingHexagon size={20} />
      <span class="thinking-label text-sm">Thinking...</span>
    </div>
  {/if}
{/if}

<SlidesBlock slides={message.slides} mode={message.mode} onDownload={onDownloadSlides} />
<FilesCreatedBlock files={message.filesCreated || []} />
<ArtifactBlock artifact={message.artifact} onOpen={onOpenArtifact} />

{#if !enableThinking && displayReasoning}
  <details class="openui-card mt-3 px-3 py-2 text-sm text-fg-secondary" style="--openui-card-bg: var(--surface-highlight);">
    <summary class="cursor-pointer font-medium">Reasoning</summary>
    <div class="mt-2 whitespace-pre-wrap">{displayReasoning}</div>
  </details>
{/if}

<style>
  .thinking-label {
    color: var(--text-muted);
    font-weight: 500;
  }
</style>
