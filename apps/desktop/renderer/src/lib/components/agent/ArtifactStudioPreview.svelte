<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { AgentArtifact } from '$lib/types/chat';
  import ArtifactRenderer from '$lib/ui/components/ArtifactRenderer.svelte';
  import DocumentViewer from '$lib/features/chat/DocumentViewer.svelte';
  import { artifactDocumentItems } from '$lib/features/chat/document-surface';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';

  interface Props { artifact: AgentArtifact; refreshKey?: number }
  let { artifact, refreshKey = 0 }: Props = $props();
  const resolved = $derived(resolveArtifactPresentation(artifact));
  const entryPath = $derived(resolved.manifest.entryPath || '');
  // Documents open in their native viewer, same as the chat reader.
  const documents = $derived(resolved.manifest.presentation === 'document' ? artifactDocumentItems(resolved) : []);
  let activeDocId = $state('');
  const activeDoc = $derived(documents.find((doc) => doc.id === activeDocId) ?? documents.find((doc) => doc.id === entryPath) ?? documents[0]);
  const previewBuild = $derived(resolved.preview
    ? buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath, true)
    : { html: '', externalRefs: [] as string[] });

</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if resolved.manifest.presentation === 'inline' && resolved.artifact.inline}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {:else if activeDoc}
    {#if documents.length > 1}
      <div class="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3 py-2" role="tablist" aria-label={$t('artifacts.studio.files')}>
        {#each documents as doc (doc.id)}
          <button type="button" role="tab" aria-selected={doc.id === activeDoc.id} class="doc-tab" class:is-on={doc.id === activeDoc.id} onclick={() => (activeDocId = doc.id)}>{doc.title}</button>
        {/each}
      </div>
    {/if}
    <div class="studio-doc min-h-0 flex-1 overflow-auto">
      {#key activeDoc.id}<DocumentViewer doc={activeDoc} />{/key}
    </div>
  {:else if previewBuild.html}
    <!--
      The page runs: scripts are allowed but the frame has an opaque origin
      (no allow-same-origin), so it can't reach the app, its storage or
      electronAPI. That is what lets small web apps work right here.
    -->
    <div class="min-h-0 flex-1 overflow-hidden bg-white">
      {#key `${refreshKey}:${previewBuild.html}`}
        <iframe class="h-full w-full border-0" srcdoc={previewBuild.html} sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title={$t('artifacts.studio.preview')}></iframe>
      {/key}
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {/if}

</div>

<style>
  .doc-tab {
    flex-shrink: 0;
    height: 1.75rem;
    padding: 0 0.75rem;
    border-radius: 9999px;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .doc-tab:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }
  .doc-tab.is-on {
    color: var(--foreground);
    background: var(--surface-active);
  }
  /* Documents fill the studio edge to edge, the way their own apps do. */
  .studio-doc {
    --doc-viewer-height: auto;
    --doc-viewer-border: 0;
    --doc-viewer-radius: 0;
    display: flex;
    flex-direction: column;
  }
</style>
