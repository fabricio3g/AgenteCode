<svelte:options runes={true} />

<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { AlertCircle, FileQuestion } from 'lucide-svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { isDataUrlFile, viewerPathFor } from '$lib/utils/artifact-files';
  import DocumentSurface from '$lib/components/chat/DocumentSurface.svelte';
  import {
    baseName,
    documentExtension,
    isDocumentSurfaceFile,
    type DocumentSurfaceItem
  } from '$lib/components/chat/document-surface';
  import InlineArtifactPreview from './InlineArtifactPreview.svelte';

  interface Props { artifact: AgentArtifact }
  let { artifact }: Props = $props();

  const resolved = $derived(resolveArtifactPresentation(artifact));
  const documentDocs = $derived.by((): DocumentSurfaceItem[] => resolved.visibleFiles
    .map(([path, content]) => {
      if (!isDocumentSurfaceFile(path)) return null;
      const ext = documentExtension(path);
      const textLike = ['md', 'markdown', 'txt', 'csv'].includes(ext);
      return {
        id: path,
        name: path,
        title: baseName(path),
        dataUrl: isDataUrlFile(content) ? content : undefined,
        content: !isDataUrlFile(content) && textLike ? content : undefined,
        previewHtml: resolved.artifact.files[viewerPathFor(path)] || '',
        kind: ext === 'md' || ext === 'markdown' ? 'report' : 'document',
        status: resolved.artifact.workProduct?.status,
        warnings: resolved.artifact.workProduct?.warnings
      };
    })
    .filter(Boolean) as DocumentSurfaceItem[]);

  const issue = $derived(resolved.manifest.issues?.[0]);
</script>

{#if resolved.manifest.status === 'invalid'}
  <div class="artifact-state artifact-state-error">
    <AlertCircle class="size-4 shrink-0" />
    <div>
      <div class="font-medium">Artifact could not be rendered</div>
      <div class="mt-0.5 text-xs opacity-80">{issue?.message || 'Open the studio to inspect the available source files.'}</div>
    </div>
  </div>
{:else if resolved.manifest.presentation === 'inline' && resolved.artifact.inline}
  <InlineArtifactPreview artifact={resolved.artifact} />
{:else if resolved.manifest.presentation === 'document' && documentDocs.length}
  <DocumentSurface docs={documentDocs} title={resolved.artifact.workProduct?.title || resolved.artifact.title} />
{:else if resolved.preview}
  <InlineArtifactPreview artifact={resolved.artifact} />
{:else}
  <div class="artifact-state">
    <FileQuestion class="size-4 shrink-0" />
    <div>
      <div class="font-medium">Source files are ready</div>
      <div class="mt-0.5 text-xs opacity-80">No compatible preview is available. Open the studio to inspect or download the files.</div>
    </div>
  </div>
{/if}

{#if resolved.manifest.status === 'partial' && issue}
  <div class="artifact-warning"><AlertCircle class="size-3.5 shrink-0" /> <span>{issue.message}</span></div>
{/if}

<style>
  .artifact-state {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    margin-top: 0.65rem;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    padding: 0.8rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }
  .artifact-state-error { color: var(--error); }
  .artifact-warning {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.45rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
  }
</style>
