<svelte:options runes={true} />

<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { resolveArtifactPreview } from '$lib/services/artifact-model';
  import { countOf } from '$lib/utils/format';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import ChartBlock from '$lib/components/chat/ChartBlock.svelte';
  import ArtifactMap from './ArtifactMap.svelte';
  import ArtifactDiagram from './ArtifactDiagram.svelte';
  import ArtifactDashboard from './ArtifactDashboard.svelte';
  import ArtifactInfoCard from './ArtifactInfoCard.svelte';
  import ArtifactHtmlCard from './ArtifactHtmlCard.svelte';

  interface Props {
    artifact: AgentArtifact;
  }

  let { artifact }: Props = $props();

  const files = $derived(artifact.files || {});
  const previewSource = $derived(resolveArtifactPreview(artifact));

  const previewBuild = $derived.by(() => {
    if (!previewSource?.html) return { html: '', externalRefs: [] as string[] };
    return buildPreviewHtml(previewSource.html, files, previewSource.basePath);
  });

  const previewSrc = $derived(previewBuild.html);
  const chartRaw = $derived.by(() => {
    if (artifact.inline?.kind !== 'chart') return '';
    return JSON.stringify({ labels: artifact.inline.labels, datasets: artifact.inline.datasets });
  });
</script>

  {#if artifact.inline?.kind === 'chart'}
  <ChartBlock type={artifact.inline.chartType} title={artifact.inline.title} raw={chartRaw} variant="artifact" />
{:else if artifact.inline?.kind === 'map'}
  <ArtifactMap payload={artifact.inline} />
{:else if artifact.inline?.kind === 'diagram'}
  <ArtifactDiagram payload={artifact.inline} />
{:else if artifact.inline?.kind === 'dashboard'}
  <ArtifactDashboard payload={artifact.inline} />
{:else if artifact.inline?.kind === 'info_card'}
  <ArtifactInfoCard payload={artifact.inline} />
{:else if artifact.inline?.kind === 'html_card'}
  <ArtifactHtmlCard payload={artifact.inline} />
{:else if previewSrc}
  <div class="inline-html-artifact">
    <iframe
      class="inline-html-frame"
      srcdoc={previewSrc}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      title={artifact.title || 'Artifact preview'}
    ></iframe>
  </div>
{/if}

{#if previewBuild.externalRefs.length}
  <div class="blocked-assets">{countOf(previewBuild.externalRefs.length, 'remote asset')} blocked for a deterministic preview.</div>
{/if}

<style>
  .inline-html-artifact {
    width: 100%;
    height: min(58vh, 430px);
    min-height: 320px;
    margin-top: 0.65rem;
    overflow: hidden;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
  }

  .blocked-assets { margin-top: 0.4rem; color: var(--text-secondary); font-size: 0.68rem; }

  .inline-html-frame {
    display: block;
    height: 100%;
    width: 100%;
    border: 0;
    background: transparent;
  }

  @media (max-width: 640px) {
    .inline-html-artifact {
      height: 360px;
      min-height: 300px;
    }
  }
</style>
