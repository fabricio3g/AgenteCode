<svelte:options runes={true} />

<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { Download, ExternalLink, ChevronDown, ChevronUp } from 'lucide-svelte';
  import JSZip from 'jszip';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { artifactFilePayload, isHiddenArtifactFile, viewerPathFor } from '$lib/utils/artifact-files';

  interface Props {
    artifact: AgentArtifact;
    onOpenSandbox?: () => void;
  }

  let { artifact, onOpenSandbox }: Props = $props();

  let collapsed = $state(false);
  let downloading = $state(false);

  const visibleEntries = $derived(
    Object.entries(artifact.files).filter(([path]) => !isHiddenArtifactFile(path))
  );
  const fileCount = $derived(visibleEntries.length);
  const fileNames = $derived(visibleEntries.map(([path]) => path));
  const primaryLabel = $derived(fileNames[0] || artifact.title || 'Preview');

  const previewHtml = $derived.by(() => {
    if (collapsed) return '';
    const htmlFile = visibleEntries.find(([k]) => k.endsWith('.html'));
    const viewerFile = visibleEntries.find(([path]) => artifact.files[viewerPathFor(path)]);
    const htmlSource = htmlFile?.[1] || (viewerFile ? artifact.files[viewerPathFor(viewerFile[0])] : '') || artifact.previewHtml || '';
    const basePath = htmlFile?.[0] || (viewerFile ? viewerPathFor(viewerFile[0]) : 'index.html');
    return htmlSource ? buildPreviewHtml(htmlSource, artifact.files, basePath).html : '';
  });

  async function downloadZip() {
    if (downloading) return;
    downloading = true;
    try {
      const zip = new JSZip();
      for (const [path, content] of Object.entries(artifact.files)) {
        if (!isHiddenArtifactFile(path)) {
          zip.file(path, artifactFilePayload(content));
        }
      }
      if (artifact.previewHtml) {
        zip.file('preview.html', artifact.previewHtml);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(artifact.title || 'artifact').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      downloading = false;
    }
  }
</script>

{#if artifact}
  <div class="artifact-preview-wrapper mt-3">
    {#if !collapsed && previewHtml}
      <div class="artifact-frame">
        <iframe
          class="artifact-iframe w-full border-0"
          srcdoc={previewHtml}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          title="{artifact.title} preview"
        ></iframe>
      </div>
    {/if}
    <div class="artifact-header">
      <div class="artifact-meta truncate">
        {primaryLabel}
        {#if fileCount > 1}
          <span class="artifact-meta-count">+{fileCount - 1}</span>
        {/if}
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="artifact-btn"
          onclick={downloadZip}
          title="Download ZIP"
          disabled={downloading}
        >
          <Download class="h-3.5 w-3.5 {downloading ? 'animate-spin' : ''}" />
        </button>
        {#if onOpenSandbox}
          <button
            class="artifact-btn"
            onclick={onOpenSandbox}
            title="Open in Sandbox"
          >
            <ExternalLink class="h-3.5 w-3.5" />
          </button>
        {/if}
        <button
          class="artifact-btn"
          onclick={() => (collapsed = !collapsed)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {#if collapsed}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronUp class="h-3.5 w-3.5" />{/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .artifact-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.45rem 0 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .artifact-meta {
    min-width: 0;
  }

  .artifact-meta-count {
    display: inline-flex;
    align-items: center;
    margin-left: 0.4rem;
  }

  .artifact-btn {
    border-radius: var(--radius-sm);
    padding: 0.3rem;
    color: var(--text-tertiary);
    transition: background 150ms ease, color 150ms ease;
  }

  .artifact-btn:hover {
    background: var(--surface);
    color: var(--text);
  }

  .artifact-frame {
    overflow: hidden;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .artifact-iframe {
    height: clamp(22rem, 56vh, 38rem);
  }
</style>
