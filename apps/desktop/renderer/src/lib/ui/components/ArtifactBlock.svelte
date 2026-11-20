<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  /*
   * An artifact in the chat. Visuals that are the answer itself (charts,
   * diagrams, maps, dashboards, cards) render inline with a quiet "open"
   * action. Everything that is a file — documents, decks, sheets, pages,
   * exports — is one compact card of the same shape; opening it shows the
   * artifact in the chat's side panel.
   */
  import type { AgentArtifact, ArtifactKind } from '$lib/types/chat';
  import { Download, FileSpreadsheet, FileText, Files, Globe, Library, Maximize2, Presentation } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { say } from '$lib/copy';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { artifactFileBlob } from '$lib/utils/artifact-files';
  import InlineArtifactPreview from './InlineArtifactPreview.svelte';
  import { artifactKindAccent } from './artifact-accent';

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
      <IconButton label={$t('artifacts.card.expand')} size="xs" variant="ghost" type="button" class={uiClass("art-expand", "ui-local-51be238f")} onclick={onOpen}  title={$t('artifacts.card.expand')}>
        <Maximize2 class="size-3.5" />
      </IconButton>
    </section>
  {:else}
    <div class="art-card" data-status={resolved.manifest.status} style:--artifact-accent={artifactKindAccent(resolved.manifest.kind)}>
      <UiButton variant="plain" type="button" class={uiClass("art-open", "ui-local-51be238f")} onclick={onOpen} title={$t('artifacts.card.open')}>
        <span class="art-sheet" aria-hidden="true"><CardIcon class="size-5" /></span>
        <span class="min-w-0 flex-1">
          <span class="art-title">{artifact.title || $t('artifacts.untitled')}</span>
          <span class="art-meta">{meta}</span>
        </span>
      </UiButton>
      {#if resolved.visibleFiles.length === 1}
        <IconButton label={$t('artifacts.card.download')} size="xs" variant="ghost" type="button" class={uiClass("art-action", "ui-local-51be238f")} onclick={downloadOnlyFile}  title={$t('artifacts.card.download')}>
          <Download class="size-4" />
        </IconButton>
      {/if}
    </div>
    {#if resolved.manifest.status === 'invalid'}
      <p class="art-note">{$t('artifacts.card.renderFailed')}</p>
    {/if}
  {/if}
{/if}

<style>
  /* A file is an object you can pick up: one soft sheet a step above the
     page, with a hairline ring. Files that follow each other stack closely. */
  .art-card {
    position: relative;
    display: flex;
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.75rem;
    align-items: stretch;
    gap: 0.25rem;
    min-height: 4rem;
    overflow: hidden;
    padding: 0 0.625rem 0 0.875rem;
    border: 1px solid var(--float-border);
    border-radius: var(--radius-lg);
    background: var(--artifact-surface);
    box-shadow: var(--control-shadow);
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease), transform var(--motion-fast) var(--motion-ease-out);
  }
  .art-card::after {
    content: '';
    position: absolute;
    top: 0;
    left: 12%;
    right: 12%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--composer-crown), transparent);
    pointer-events: none;
  }
  :global(.art-card + .art-card) {
    margin-top: 0.375rem;
  }
  .art-card:hover {
    background: var(--artifact-surface-hover);
    border-color: var(--border-hover);
    transform: translateY(-1px);
  }
  .art-card:active {
    transform: translateY(0);
  }
  .art-card[data-status='invalid'] {
    border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  }
  :global(.art-open.ui-local-51be238f) {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.875rem;
    padding: 0;
    border-radius: 0.625rem;
    text-align: left;
    cursor: pointer;
  }
  /* The file itself: a sheet of paper with a folded corner, standing in the
     card and cut off by its bottom edge. The kind's colour is on the glyph
     only, so a row of files stays grey with one small hue each. */
  .art-sheet {
    position: relative;
    display: inline-flex;
    width: 2.75rem;
    height: 3.25rem;
    flex-shrink: 0;
    align-self: flex-end;
    align-items: center;
    justify-content: center;
    padding-top: 0.25rem;
    border-radius: 0.375rem 0 0 0;
    background: color-mix(in srgb, var(--foreground) 9%, var(--artifact-surface));
    color: var(--artifact-accent);
    clip-path: polygon(0 0, calc(100% - 0.75rem) 0, 100% 0.75rem, 100% 100%, 0 100%);
    transition: translate var(--motion-fast) var(--motion-ease-out);
  }
  .art-sheet::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: 0.75rem;
    height: 0.75rem;
    border-bottom-left-radius: 0.25rem;
    background: color-mix(in srgb, var(--foreground) 18%, var(--artifact-surface));
  }
  .art-card:hover .art-sheet {
    translate: 0 -2px;
  }
  :global(.art-open:focus-visible.ui-local-51be238f),
  :global(.art-action:focus-visible.ui-local-51be238f),
  :global(.art-expand:focus-visible.ui-local-51be238f) {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 40%, transparent);
  }
  .art-title,
  .art-meta {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .art-title {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--foreground);
  }
  .art-meta {
    margin-top: 1px;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  :global(.art-action.ui-local-51be238f) {
    align-self: center;
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
  :global(.art-action:hover.ui-local-51be238f) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .art-note {
    margin-top: 0.375rem;
    font-size: var(--text-xs);
    color: var(--error);
  }

  .art-inline {
    position: relative;
    display: flex;
    flex-direction: column;
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.75rem;
  }
  /* Expand sits at the end of the artifact's own header row, so it costs no
     line of its own; the header leaves it room. */
  .art-inline > :global(.viz-surface > .viz-header) {
    padding-right: 2.25rem;
  }
  :global(.art-expand.ui-local-51be238f) {
    position: absolute;
    top: 2.375rem;
    right: 0;
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--muted-foreground);
    opacity: 0.7;
    transition: opacity var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .art-inline:hover :global(.art-expand.ui-local-51be238f),
  :global(.art-expand:focus-visible.ui-local-51be238f) {
    opacity: 1;
  }
  :global(.art-expand:hover.ui-local-51be238f) {
    color: var(--foreground);
  }
  @media (hover: none) {
    :global(.art-expand.ui-local-51be238f) {
      opacity: 1;
    }
  }
</style>
