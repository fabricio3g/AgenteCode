<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { AgentArtifact } from '$lib/types/chat';
  import { resolveArtifactPreview } from '$lib/services/artifact-model';
  import { countOf } from '$lib/utils/format';
  import { buildArtifactPreviewHtml } from '$lib/utils/preview-builder';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
  import ArtifactMap from './ArtifactMap.svelte';
  import ArtifactDiagram from './ArtifactDiagram.svelte';
  import ArtifactDashboard from './ArtifactDashboard.svelte';
  import ArtifactInfoCard from './ArtifactInfoCard.svelte';
  import ArtifactHtmlCard from './ArtifactHtmlCard.svelte';
  import ArtifactLesson from './ArtifactLesson.svelte';
  import { FileQuestion } from '$lib/icons';

  interface Props {
    artifact: AgentArtifact;
    /** Library thumbnails render a static poster rather than live controls. */
    poster?: boolean;
    /** A space other than Home opened this artifact: read it, do not work it. */
    readOnly?: boolean;
  }

  let { artifact, poster = false, readOnly = false }: Props = $props();

  const files = $derived(artifact.files || {});
  const previewSource = $derived(resolveArtifactPreview(artifact));

  const previewBuild = $derived.by(() => {
    if (!previewSource?.html) return { html: '', externalRefs: [] as string[] };
    return buildArtifactPreviewHtml(previewSource.html, files, previewSource.basePath);
  });

  const previewSrc = $derived(previewBuild.html);
  // Captured before the dispatch chain: inside the terminal {:else} TypeScript has
  // narrowed `artifact.inline` to `never`, so the unrecognised kind is unreadable there.
  const inlineKind = $derived(artifact.inline?.kind ? String(artifact.inline.kind) : '');

  const chartRaw = $derived.by(() => {
    if (artifact.inline?.kind !== 'chart') return '';
    return JSON.stringify(artifact.inline);
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
{:else if artifact.inline?.kind === 'lesson'}
  <ArtifactLesson payload={artifact.inline} entryKey={artifact.manifest?.entryPath} {poster} {readOnly} />
{:else if previewSrc}
  <div class="inline-html-artifact">
    <iframe
      class="artifact-preview-frame h-full w-full"
      srcdoc={previewSrc}
      sandbox=""
      referrerpolicy="no-referrer"
      title={artifact.title || $t('artifacts.untitled')}
    ></iframe>
  </div>
{:else}
  <!--
    A terminal branch is required here. Without it an artifact whose presentation
    resolved to `inline` but whose `kind` matched none of the above rendered
    literally nothing — and because ArtifactRenderer had already committed to this
    component, its own fallback was unreachable. That is real: `normalizeArtifact`
    does not re-validate `inline.kind`, so anything rehydrated from storage or
    written by another app version bypasses the tool-side whitelist.
  -->
  <div class="inline-unsupported">
    <FileQuestion class="size-4 shrink-0" />
    <div>
      <div class="font-medium">{$t('artifacts.card.unsupported')}</div>
      <div class="mt-0.5 text-xs opacity-80">
        {inlineKind ? $t('artifacts.card.unknownKind', { values: { kind: inlineKind } }) : $t('artifacts.card.noData')}
        {$t('artifacts.card.openToInspect')}
      </div>
    </div>
  </div>
{/if}

{#if previewBuild.externalRefs.length}
  <div class="blocked-assets">{countOf(previewBuild.externalRefs.length, 'remote asset')} blocked for a deterministic preview.</div>
{/if}

<style>
  .inline-html-artifact {
    width: var(--inline-block-width);
    max-width: 100%;
    height: min(58vh, 430px);
    min-height: 320px;
    margin-top: 0.65rem;
    overflow: hidden;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
  }

  .blocked-assets { margin-top: 0.4rem; color: var(--text-secondary); font-size: var(--text-xs); }

  /* Matches `.artifact-state` in ArtifactRenderer so the two fallbacks look alike. */
  .inline-unsupported {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.65rem;
    padding: 0.8rem;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  @media (max-width: 640px) {
    .inline-html-artifact {
      height: 360px;
      min-height: 300px;
    }
  }
</style>
