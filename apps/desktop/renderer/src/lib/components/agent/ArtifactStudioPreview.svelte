<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { AgentArtifact } from '$lib/types/chat';
  import ArtifactRenderer from '$lib/ui/components/ArtifactRenderer.svelte';
  import DocumentViewer from '$lib/features/chat/DocumentViewer.svelte';
  import { artifactDocumentItems } from '$lib/features/chat/document-surface';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';

  import ViewerTabs from '$lib/features/chat/viewers/ViewerTabs.svelte';
  import { useViewerControls } from '$lib/features/chat/viewers/viewer-controls.svelte';
  const controls = useViewerControls();

  interface Props { artifact: AgentArtifact; refreshKey?: number }
  let { artifact, refreshKey = 0 }: Props = $props();
  const resolved = $derived(resolveArtifactPresentation(artifact));
  const entryPath = $derived(resolved.manifest.entryPath || '');
  // Documents open in their native viewer, same as the chat reader.
  const documents = $derived(resolved.manifest.presentation === 'document' ? artifactDocumentItems(resolved) : []);
  let activeDocId = $state('');
  $effect(() => { if (controls) controls.title = activeDoc?.title || activeDoc?.name || ''; return () => { if (controls) controls.title = ''; }; });
  const activeDoc = $derived(documents.find((doc) => doc.id === activeDocId) ?? documents.find((doc) => doc.id === entryPath) ?? documents[0]);
  const previewBuild = $derived(resolved.preview
    ? buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath, true)
    : { html: '', externalRefs: [] as string[] });

</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if resolved.manifest.presentation === 'inline' && resolved.artifact.inline}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {:else if activeDoc}
    <ViewerTabs items={documents.map(doc => ({ id: doc.id, title: doc.title || doc.name }))} active={activeDoc.id} onchange={id => { activeDocId = id; if (controls) { controls.query = ''; controls.searchOpen = false; } }} />
    <div class="studio-doc min-h-0 flex-1 overflow-hidden">
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
  .studio-doc { display:flex; min-width:0; flex-direction:column; margin:0 4px 4px; border-radius:8px; overflow:hidden; }
</style>
