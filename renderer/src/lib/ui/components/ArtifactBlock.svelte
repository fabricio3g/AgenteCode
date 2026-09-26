<script lang="ts">
  /*
   * An artifact in the chat. Visuals that are the answer itself (charts,
   * diagrams, maps, dashboards, cards) render inline with a quiet "open"
   * action. Everything that is a file — documents, decks, sheets, pages,
   * exports — is one compact card of the same shape; opening it shows the
   * artifact in the chat's side panel.
   */
  import type { AgentArtifact, ArtifactKind } from '$lib/types/chat';
  import { Download, FileSpreadsheet, FileText, Files, Globe, Library, Maximize2, Presentation } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { say } from '$lib/copy';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { artifactFileBlob } from '$lib/utils/artifact-files';
  import InlineArtifactPreview from './InlineArtifactPreview.svelte';

  interface Props {
    artifact?: AgentArtifact | null;
    onOpen: () => void;
  }

  let { artifact = null, onOpen }: Props = $props();
  const resolved = $derived(artifact ? resolveArtifactPresentation(artifact) : null);
  /*
   * Inline artifacts are backed by a single JSON data file that is only the
   * preview's storage; they render as the preview alone, never as a file.
   */
  const inline = $derived(!!resolved && resolved.manifest.presentation === 'inline' && !!resolved.artifact.inline);

  const ICONS: Partial<Record<ArtifactKind, typeof FileText>> = {
    report: FileText,
    work_product: FileText,
    document: FileText,
    pdf: FileText,
    spreadsheet: FileSpreadsheet,
    presentation: Presentation,
    research_package: Library,
    web: Globe
  };
  const CardIcon = $derived((resolved && ICONS[resolved.manifest.kind]) || Files);

  /** "Presentation · PPTX", "Research package · 2 files". */
  const meta = $derived.by(() => {
    if (!resolved) return '';
    const files = resolved.visibleFiles;
    const inline = resolved.artifact.inline;
    const kind = inline?.kind === 'html_card' && inline.script
      ? $t('artifacts.kind.widget')
      : $t(`artifacts.kind.${resolved.manifest.kind}`);
    const detail = files.length === 1
      ? (files[0][0].split('.').pop() || '').toUpperCase()
      : say.files(files.length);
    const status = resolved.manifest.status !== 'ready' ? $t(`artifacts.status.${resolved.manifest.status}`) : '';
    return [kind, detail, status].filter(Boolean).join(' · ');
  });

  function downloadOnlyFile(event: MouseEvent) {
    event.stopPropagation();
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
  {#if inline}
    <section class="art-inline" data-status={resolved.manifest.status}>
      <InlineArtifactPreview artifact={resolved.artifact} />
      <button type="button" class="art-expand" onclick={onOpen} aria-label={$t('artifacts.card.expand')} title={$t('artifacts.card.expand')}>
        <Maximize2 class="size-3.5" />
      </button>
    </section>
  {:else}
    <div class="art-card" data-status={resolved.manifest.status}>
      <button type="button" class="art-open" onclick={onOpen} title={$t('artifacts.card.open')}>
        <span class="art-icon" aria-hidden="true"><CardIcon class="size-[18px]" /></span>
        <span class="min-w-0 flex-1">
          <span class="art-title">{artifact.title || $t('artifacts.untitled')}</span>
          <span class="art-meta">{meta}</span>
        </span>
      </button>
      {#if resolved.visibleFiles.length === 1}
        <button type="button" class="art-action" onclick={downloadOnlyFile} aria-label={$t('artifacts.card.download')} title={$t('artifacts.card.download')}>
          <Download class="size-4" />
        </button>
      {/if}
    </div>
    {#if resolved.manifest.status === 'invalid'}
      <p class="art-note">{$t('artifacts.card.renderFailed')}</p>
    {/if}
  {/if}
{/if}

<style>
  .art-card {
    display: flex;
    width: min(100%, 26rem);
    margin-top: 0.75rem;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem 0.375rem 0.375rem;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    background: var(--background);
    transition: border-color var(--motion-fast) var(--motion-ease);
  }
  .art-card:hover {
    border-color: color-mix(in srgb, var(--foreground) 20%, var(--border));
  }
  .art-card[data-status='invalid'] {
    border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  }
  .art-open {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.75rem;
    padding: 0.125rem;
    border-radius: 0.625rem;
    text-align: left;
    cursor: pointer;
  }
  .art-open:focus-visible,
  .art-action:focus-visible,
  .art-expand:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 40%, transparent);
  }
  .art-icon {
    display: inline-flex;
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.625rem;
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .art-title,
  .art-meta {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .art-title {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--foreground);
  }
  .art-meta {
    margin-top: 1px;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .art-action {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .art-action:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .art-note {
    margin-top: 0.375rem;
    font-size: 12px;
    color: var(--error);
  }

  .art-inline {
    position: relative;
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.75rem;
  }
  .art-expand {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--background);
    color: var(--muted-foreground);
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .art-inline:hover .art-expand,
  .art-expand:focus-visible {
    opacity: 1;
  }
  .art-expand:hover {
    color: var(--foreground);
  }
  @media (hover: none) {
    .art-expand {
      opacity: 1;
    }
  }
</style>
