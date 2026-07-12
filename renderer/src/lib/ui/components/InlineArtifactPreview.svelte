<svelte:options runes={true} />

<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { isHiddenArtifactFile } from '$lib/utils/artifact-files';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import ChartBlock from '$lib/components/chat/ChartBlock.svelte';
  import ArtifactMap from './ArtifactMap.svelte';
  import ArtifactDiagram from './ArtifactDiagram.svelte';
  import ArtifactDashboard from './ArtifactDashboard.svelte';

  interface Props {
    artifact: AgentArtifact;
  }

  let { artifact }: Props = $props();

  const files = $derived(artifact.files || {});
  const visibleEntries = $derived(Object.entries(files).filter(([path]) => !isHiddenArtifactFile(path)));
  const htmlEntry = $derived(visibleEntries.find(([path]) => /\.html?$/i.test(path)) || null);
  const previewSource = $derived.by(() => {
    if (artifact.previewHtml) {
      return {
        html: artifact.previewHtml,
        basePath: htmlEntry?.[0] || 'index.html'
      };
    }

    if (htmlEntry) {
      return {
        html: htmlEntry[1],
        basePath: htmlEntry[0]
      };
    }

    return null;
  });

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

<style>
  .inline-html-artifact {
    width: min(100%, 42rem);
    height: min(58vh, 430px);
    min-height: 320px;
    margin-top: 0.65rem;
    overflow: hidden;
    background: transparent;
  }

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
