<svelte:options runes={true} />

<!--
  Renders the ordered parts of an assistant message.

  The ordering and the mutual-exclusion rules live in `message-parts.ts`; this
  file is only a switch. That split is deliberate: the rules are the part that
  kept getting broken, and they are now covered by tests instead of comments.
-->

<script lang="ts">
  import { AlertCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { artifactsForMessage } from '$lib/stores/app-store-artifacts';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { generatePptx } from '$lib/services/slides';
  import { buildUIActionMessage } from '$lib/ui';
  import type { ActionEvent } from '$lib/ui';
  import { APP_NAME } from '$lib/app-meta';

  import ApprovalRequest from '$lib/components/agent/ApprovalRequest.svelte';
  import DeepResearchWidget from '$lib/components/search/DeepResearchWidget.svelte';
  import DocumentSurface from '$lib/features/chat/DocumentSurface.svelte';
  import AgentBlock from '$lib/ui/components/AgentBlock.svelte';
  import ArtifactBlock from '$lib/ui/components/ArtifactBlock.svelte';
  import FilesCreatedBlock from '$lib/ui/components/FilesCreatedBlock.svelte';
  import ReasoningBlock from '$lib/ui/components/ReasoningBlock.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import SlidesBlock from '$lib/ui/components/SlidesBlock.svelte';

  import WritingIndicator from './WritingIndicator.svelte';
  import { useMessage } from './message-context';
  import { buildMessageParts, resolveTotalElapsed } from './message-parts';

  const ctx = useMessage();

  const hasActiveDeepResearch = $derived(
    !!deepResearchStore.getActiveTaskForMessage(ctx.message.id)
  );
  // Any document artifact in the turn suppresses the metadata-driven report
  // surface, otherwise the same document renders twice.
  const hasDocumentArtifact = $derived(
    artifactsForMessage(ctx.message).some(
      (artifact) => resolveArtifactPresentation(artifact).manifest.presentation === 'document'
    )
  );

  /*
   * Approvals are stored per chat, so they are attributed to the one live
   * assistant message in that chat rather than matched on a step id — the id
   * match is exactly what never fired on the supervised-bash path.
   */
  const pendingApprovals = $derived.by(() => {
    const chatId = appStore.currentChatId || '';
    if (!chatId) return [];
    if (appStore.activeRunsByChat[chatId]?.messageId !== ctx.message.id) return [];
    return approvalsStore.forChat(chatId);
  });

  const parts = $derived(
    buildMessageParts({
      message: ctx.message,
      displayContent: ctx.displayContent,
      displayReasoning: ctx.displayReasoning,
      displayMetadata: ctx.displayMetadata,
      enableThinking: !!appStore.config.ui?.enable_thinking,
      hasActiveDeepResearch,
      hasDocumentArtifact,
      hasPendingApproval: pendingApprovals.length > 0
      // Roleplay has its own artifacts — props — and they live on the reply.
      // Agent work products (reports, spreadsheets) belong to the tool loop,
      // which never runs in a scene, so they are never shown here.
    }).filter((part) => ctx.contextMode !== 'roleplay' || part.kind !== 'artifact')
  );

  async function downloadSlides() {
    const slides = ctx.message.slides;
    if (!slides?.length) return;
    const bytes = await generatePptx({
      title: slides[0]?.title || `${APP_NAME} Presentation`,
      slides
    });
    const blob = new Blob([new Uint8Array(bytes)], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(slides[0]?.title || 'presentation').replace(/[^a-z0-9]+/gi, '_')}.pptx`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleUIAction(event: ActionEvent) {
    if (event.type === 'open_url') {
      const url = String(event.params?.url || '');
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    appStore.composer = buildUIActionMessage(event);
    await appStore.sendCurrentMessage();
  }
</script>

<!--
  Keyed on kind *plus* index: a turn can contribute more than one `artifact` part,
  and duplicate keys in a keyed each is a Svelte error.
-->
{#each parts as part (part.kind === 'artifact' ? `artifact:${part.index}` : part.kind)}
  {#if part.kind === 'deep-research'}
    <DeepResearchWidget messageId={ctx.message.id} />
  {:else if part.kind === 'reasoning'}
    <div class="aui-cot-stack mb-1 w-full">
      <ReasoningBlock
        reasoning={part.reasoning}
        status={ctx.message.status}
        timing={part.timing}
        totalElapsedSeconds={part.totalElapsedSeconds}
        variant="outline"
      />
    </div>
  {:else if part.kind === 'tool-status'}
    <div class="aui-cot-stack mb-1 w-full">
      <AgentBlock
        steps={ctx.message.agentSteps || []}
        reasoning={appStore.config.ui?.enable_thinking ? ctx.displayReasoning : ''}
        status={ctx.message.status}
        totalElapsedSeconds={resolveTotalElapsed(ctx.message, ctx.displayMetadata)}
        outcome={ctx.displayMetadata?.outcome}
        stopReason={ctx.displayMetadata?.stopReason || ctx.displaySearchMeta?.stopReason}
        currentActivity={ctx.displayMetadata?.currentActivity}
        activityLabel={ctx.displayMetadata?.activityLabel}
        messageId={ctx.message.id}
        searchMode={ctx.message.searchMode || null}
        awaitingApproval={pendingApprovals.length > 0}
      />
    </div>
  {:else if part.kind === 'approval'}
    <ApprovalRequest approvals={pendingApprovals} />
  {:else if part.kind === 'error'}
    <div class="mb-3 flex items-start gap-2.5 rounded-lg bg-error-bg px-4 py-3 text-sm text-error">
      <AlertCircle class="mt-0.5 size-4 shrink-0" />
      <div>
        <div class="font-semibold text-foreground">{part.title}</div>
        {#if part.detail}
          <div class="mt-0.5 text-xs opacity-80">{part.detail}</div>
        {/if}
      </div>
    </div>
  {:else if part.kind === 'warning'}
    <div class="mb-2 text-xs text-muted-foreground">{part.detail}</div>
  {:else if part.kind === 'pending'}
    <div class="my-2 flex items-center gap-2">
      <WritingIndicator />
      {#if part.status}
        <span class="pending-label text-xs text-muted-foreground">{part.status}</span>
      {/if}
    </div>
  {:else if part.kind === 'content'}
    <RichContent
      content={part.content}
      status={ctx.message.status}
      metadataError={!!ctx.displayMetadata?.error}
      sources={ctx.message.sources}
      searchMode={ctx.message.searchMode || null}
      onAction={handleUIAction}
    />
  {:else if part.kind === 'document'}
    <!-- The footer owns the source count; the surface must not repeat it. -->
    <DocumentSurface docs={part.docs} title={part.title} sourceCount={0} allowDownload={false} />
  {:else if part.kind === 'slides'}
    <SlidesBlock slides={ctx.message.slides} mode={ctx.message.mode} onDownload={downloadSlides} />
  {:else if part.kind === 'files-created'}
    <FilesCreatedBlock files={ctx.message.filesCreated || []} />
  {:else if part.kind === 'artifact'}
    <ArtifactBlock
      artifact={part.artifact}
      onOpen={() => appStore.openArtifact(part.artifact, ctx.message.id)}
    />
  {/if}
{/each}
