<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { ExternalLink, FolderOpen } from 'lucide-svelte';
  import { isSimpleArtifact } from '$lib/utils/preview-builder';
  import { isDataUrlFile, viewerPathFor } from '$lib/utils/artifact-files';
  import DocumentSurface from '$lib/components/chat/DocumentSurface.svelte';
  import InlineArtifactPreview from './InlineArtifactPreview.svelte';
  import {
    baseName,
    documentExtension,
    isDocumentSurfaceFile,
    type DocumentSurfaceItem
  } from '$lib/components/chat/document-surface';

  interface Props {
    artifact?: AgentArtifact | null;
    onOpen: () => void;
  }

  let { artifact = null, onOpen }: Props = $props();

  const visibleEntries = $derived(Object.entries(artifact?.files || {}).filter(([k]) => !k.startsWith('__')));
  const fileCount = $derived(visibleEntries.length);

  const isSimple = $derived(isSimpleArtifact(artifact));

  const documentDocs = $derived.by((): DocumentSurfaceItem[] => {
    if (!artifact) return [];
    return visibleEntries
      .map(([path, content]) => {
        if (!isDocumentSurfaceFile(path)) return null;
        const ext = documentExtension(path);
        const isTextLike = ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'csv';
        return {
          id: path,
          name: path,
          title: baseName(path),
          dataUrl: isDataUrlFile(content) ? content : undefined,
          content: !isDataUrlFile(content) && isTextLike ? content : undefined,
          previewHtml: artifact.files[viewerPathFor(path)] || '',
          kind: ext === 'md' || ext === 'markdown' ? 'report' : 'document',
          status: artifact.workProduct?.status,
          warnings: artifact.workProduct?.warnings
        };
      })
      .filter(Boolean) as DocumentSurfaceItem[];
  });

  const nonDocumentFileCount = $derived(visibleEntries.filter(([path]) => !isDocumentSurfaceFile(path)).length);
  const hasWebPreview = $derived.by(() => {
    if (!artifact || nonDocumentFileCount === 0) return false;
    if (artifact.inline) return true;
    return !!artifact.previewHtml || visibleEntries.some(([path]) => !isDocumentSurfaceFile(path) && /\.html?$/i.test(path));
  });
</script>

{#if artifact}
  {#if documentDocs.length}
    <DocumentSurface
      docs={documentDocs}
      title={artifact.workProduct?.title || artifact.title || (documentDocs.length > 1 ? 'Generated documents' : documentDocs[0].title)}
    />
  {/if}

  {#if hasWebPreview}
    <InlineArtifactPreview {artifact} />
  {:else if nonDocumentFileCount > 0 || (!documentDocs.length && isSimple)}
    <div class="artifact-card flex items-center justify-between gap-3 after-preview">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <div class="artifact-icon">
          <FolderOpen class="h-3.5 w-3.5" />
        </div>
        <div class="min-w-0">
          <div class="title truncate">{artifact.title || 'Workspace'}</div>
          <div class="subtitle">
            {fileCount} file{fileCount !== 1 ? 's' : ''}{#if artifact.previewHtml} · preview ready{/if}
          </div>
        </div>
      </div>
      <button class="open-sandbox-btn flex shrink-0 items-center justify-center" onclick={onOpen} aria-label="Open workspace" title="Open workspace">
        <ExternalLink class="h-3.5 w-3.5" />
      </button>
    </div>
  {:else if !documentDocs.length}
    <div class="artifact-card flex items-center justify-between gap-3">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <div class="artifact-icon">
          <FolderOpen class="h-3.5 w-3.5" />
        </div>
        <div class="min-w-0">
          <div class="title truncate">{artifact.title || 'Workspace'}</div>
          <div class="subtitle">
            {fileCount} file{fileCount !== 1 ? 's' : ''}{#if artifact.previewHtml} · preview ready{/if}
          </div>
        </div>
      </div>
      <button class="open-sandbox-btn flex shrink-0 items-center justify-center" onclick={onOpen} aria-label="Open workspace" title="Open workspace">
        <ExternalLink class="h-3.5 w-3.5" />
      </button>
    </div>
  {/if}
{/if}

<style>
  .artifact-card {
    margin-top: 0.75rem;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0.35rem 0;
    box-shadow: none;
  }

  .artifact-card.after-preview {
    margin-top: 0.45rem;
  }

  .artifact-icon {
    display: inline-flex;
    height: 1.35rem;
    width: 1.35rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-tertiary);
  }

  .title {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
  }

  .subtitle {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-top: 0.1rem;
  }

  .open-sandbox-btn {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    width: 1.85rem;
    height: 1.85rem;
    color: var(--text-secondary);
    padding: 0;
    transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .open-sandbox-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
