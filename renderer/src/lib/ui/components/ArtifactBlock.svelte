<script lang="ts">
  import type { AgentArtifact, ArtifactKind } from '$lib/types/chat';
  import { Download, ExternalLink, FolderOpen } from 'lucide-svelte';
  import { say } from '$lib/copy';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { artifactFileBlob } from '$lib/utils/artifact-files';
  import ArtifactRenderer from './ArtifactRenderer.svelte';

  interface Props {
    artifact?: AgentArtifact | null;
    onOpen: () => void;
  }

  let { artifact = null, onOpen }: Props = $props();
  const resolved = $derived(artifact ? resolveArtifactPresentation(artifact) : null);
  /*
   * Inline artifacts (info cards, charts, diagrams, …) are backed by a single
   * JSON data file — `weather-card.json`, `chart.json` — that is only the
   * preview's storage. Surfacing it as a file card exposes an internal detail
   * the user never asked for, so these render as the preview alone with no
   * filename, file count or raw-JSON download.
   */
  const inlineOnly = $derived(
    !!resolved && resolved.manifest.presentation === 'inline' && !!resolved.artifact.inline
  );

  const kindLabels: Record<ArtifactKind, string> = {
    report: 'Report', work_product: 'Work product', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', pdf: 'PDF',
    chart: 'Chart', diagram: 'Diagram', map: 'Map', dashboard: 'Dashboard', info_card: 'Info card', html_card: 'HTML card',
    research_package: 'Research package', web: 'Web preview', files: 'Files'
  };

  function downloadOnlyFile() {
    const entry = resolved?.visibleFiles[0];
    if (!entry || resolved?.visibleFiles.length !== 1) return;
    const [path, content] = entry;
    const url = URL.createObjectURL(artifactFileBlob(content));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').pop() || 'artifact-file';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

{#if artifact && resolved}
  <section class="artifact-shell" data-status={resolved.manifest.status}>
    {#if !inlineOnly}
    <header class="artifact-header">
      <div class="artifact-heading">
        <span class="artifact-icon"><FolderOpen class="size-3.5" /></span>
        <span class="min-w-0">
          <span class="artifact-title">{artifact.title || 'Artifact'}</span>
          <span class="artifact-subtitle">
            {kindLabels[resolved.manifest.kind]} · {say.files(resolved.visibleFiles.length)}
            {#if resolved.manifest.status !== 'ready'} · {resolved.manifest.status}{/if}
          </span>
        </span>
      </div>
      <div class="artifact-actions">
        {#if resolved.visibleFiles.length === 1}
          <button type="button" class="aui-icon-button size-8" onclick={downloadOnlyFile} aria-label="Download artifact" title="Download artifact">
            <Download class="size-3.5" />
          </button>
        {/if}
        <button type="button" class="aui-icon-button size-8" onclick={onOpen} aria-label="Open artifact studio" title="Open artifact studio">
          <ExternalLink class="size-3.5" />
        </button>
      </div>
    </header>
    {/if}
    <ArtifactRenderer {artifact} />
  </section>
{/if}

<style>
  .artifact-shell { width: var(--inline-block-width);
    max-width: 100%; margin-top: 0.75rem; }
  .artifact-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 3rem; padding: 0.5rem 0.6rem 0.5rem 0.8rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-2xl); background: var(--surface); }
  .artifact-heading { display: flex; min-width: 0; align-items: center; gap: 0.55rem; }
  .artifact-icon { display: inline-flex; width: 1.65rem; height: 1.65rem; flex-shrink: 0; align-items: center; justify-content: center; border-radius: var(--radius-sm); background: var(--artifact-surface-hover); color: var(--text-secondary); }
  .artifact-title, .artifact-subtitle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artifact-title { color: var(--text); font-size: 0.78rem; font-weight: 600; }
  .artifact-subtitle { margin-top: 0.05rem; color: var(--text-secondary); font-size: 0.67rem; text-transform: capitalize; }
  .artifact-actions { display: flex; align-items: center; gap: 0.1rem; }
</style>
