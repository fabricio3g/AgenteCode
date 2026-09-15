<svelte:options runes={true} />

<script lang="ts">
  import { AlertCircle, Download, ExternalLink, FileText, Files, Search, X } from 'lucide-svelte';
  import { motionFade } from '$lib/utils/transitions';
  import Portal from '$lib/ui/components/Portal.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { parseContentSegments } from '$lib/utils/charts';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
  import { getFileIcon, getViewerKind, downloadFromDataUrl, downloadFromSrc } from '$lib/utils/doc-utils';
  import type { ViewerKind } from '$lib/utils/doc-utils';
  import PdfViewer from './viewers/PdfViewer.svelte';
  import DocxViewer from './viewers/DocxViewer.svelte';
  import XlsxViewer from './viewers/XlsxViewer.svelte';
  import TextViewer from './viewers/TextViewer.svelte';
  import SlidesViewer from './SlidesViewer.svelte';
  import { baseName, fileTypeLabel, type DocumentSurfaceItem } from './document-surface';

  interface Props {
    docs?: DocumentSurfaceItem[];
    title?: string;
    sourceCount?: number;
    className?: string;
    launcherMode?: 'tile' | 'strip';
    allowDownload?: boolean;
    onDownloadSlides?: () => void;
  }

  let {
    docs = [],
    title = '',
    sourceCount = 0,
    className = '',
    launcherMode = 'tile',
    allowDownload = true,
    onDownloadSlides
  }: Props = $props();

  let open = $state(false);
  let activeId = $state('');
  let query = $state('');
  let previewEl = $state<HTMLElement | undefined>(undefined);

  const visibleDocs = $derived((docs || []).filter(Boolean));
  const activeDoc = $derived.by(() => {
    if (!visibleDocs.length) return null;
    return visibleDocs.find((doc) => doc.id === activeId) || visibleDocs[0];
  });
  function cleanSurfaceTitle(value: string) {
    const raw = (value || '').trim();
    if (!raw || /^agent workspace\s*\(/i.test(raw) || raw.toLowerCase() === 'work product') {
      if (activeDoc?.kind === 'report') return 'Report';
      if (activeDoc?.kind === 'slides') return 'Slides';
      if (visibleDocs.length > 1) return 'Documents';
      return activeDoc?.title || baseName(activeDoc?.name || '') || 'Document';
    }
    return raw;
  }

  const surfaceTitle = $derived(cleanSurfaceTitle(title || activeDoc?.title || activeDoc?.name || ''));
  const primaryType = $derived(activeDoc ? fileTypeLabel(activeDoc.name, activeDoc.kind) : 'FILE');
  const primaryIcon = $derived(activeDoc ? getFileIcon(activeDoc.name, activeDoc.type || '') : FileText);
  const subtitle = $derived.by(() => {
    const parts = [
      visibleDocs.length > 1 ? `${visibleDocs.length} files` : primaryType,
      sourceCount > 0 ? `${sourceCount} sources` : ''
    ].filter(Boolean);
    return parts.join(' · ');
  });
  const warnings = $derived(Array.from(new Set(visibleDocs.flatMap((doc) => doc.warnings || []))));
  const status = $derived(visibleDocs.find((doc) => doc.status)?.status || (warnings.length ? 'partial' : 'ready'));
  const activeText = $derived((activeDoc?.content || '').toLowerCase());
  const safePreviewHtml = $derived(activeDoc?.previewHtml ? buildPreviewHtml(activeDoc.previewHtml, {}, activeDoc.name).html : '');
  const searchTerm = $derived(query.trim());
  const canSearch = $derived.by(() => {
    if (!activeDoc) return false;
    return isMarkdown(activeDoc) || viewerKind(activeDoc) === 'text' || viewerKind(activeDoc) === 'xlsx';
  });
  const searchMatchCount = $derived.by(() => {
    const term = searchTerm.toLowerCase();
    if (!term || !activeText) return 0;
    return activeText.split(term).length - 1;
  });
  const searchHit = $derived(searchTerm ? (searchMatchCount > 0 || viewerKind(activeDoc) === 'xlsx') : false);

  function stop(event: Event) {
    event.stopPropagation();
  }

  function openReader(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    activeId = activeDoc?.id || visibleDocs[0]?.id || '';
    open = true;
  }

  function openReaderFor(doc: DocumentSurfaceItem, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    activeId = doc.id;
    open = true;
  }

  function closeReader(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') open = false;
  }

  function handleCapsuleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    openReader();
  }

  function handleLauncherKeydown(doc: DocumentSurfaceItem, event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    openReaderFor(doc);
  }

  function utf8Base64(value: string) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunk));
    }
    return btoa(binary);
  }

  function docSource(doc: DocumentSurfaceItem | null) {
    if (!doc) return '';
    if (doc.dataUrl) return doc.dataUrl;
    if (doc.content !== undefined) {
      const mime = doc.name.endsWith('.csv')
        ? 'text/csv'
        : doc.name.endsWith('.md') || doc.name.endsWith('.markdown')
          ? 'text/markdown'
          : 'text/plain';
      return `data:${mime};charset=utf-8;base64,${utf8Base64(doc.content)}`;
    }
    return '';
  }

  function viewerKind(doc: DocumentSurfaceItem | null): ViewerKind {
    if (!doc) return 'unknown';
    if (doc.kind === 'slides') return 'pptx';
    return getViewerKind(doc.name, doc.type || '');
  }

  function isMarkdown(doc: DocumentSurfaceItem | null) {
    const name = doc?.name.toLowerCase() || '';
    return doc?.kind === 'report' || name.endsWith('.md') || name.endsWith('.markdown');
  }

  function highlightedMarkdown(content: string) {
    const html = renderMarkdown(content || '');
    const term = searchTerm;
    if (!term) return html;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  function reportSegments(content: string) {
    return parseContentSegments(content || '');
  }

  $effect(() => {
    if (!open || !searchTerm || !previewEl || !isMarkdown(activeDoc)) return;
    requestAnimationFrame(() => {
      previewEl?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  function downloadDoc(doc: DocumentSurfaceItem | null, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (!doc) return;
    if (doc.kind === 'slides' && onDownloadSlides) {
      onDownloadSlides();
      return;
    }
    const source = docSource(doc);
    if (!source) return;
    if (source.startsWith('data:')) {
      downloadFromDataUrl(source, baseName(doc.name));
    } else {
      downloadFromSrc(source, baseName(doc.name));
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visibleDocs.length}
  <div class={`document-surface ${className}`}>
    {#if launcherMode === 'strip'}
      <div class="attachment-strip" aria-label={surfaceTitle}>
        {#each visibleDocs as doc (doc.id)}
          <div
            class:attachment-image={viewerKind(doc) === 'image'}
            class="attachment-launcher"
            role="button"
            tabindex="0"
            onclick={(event) => openReaderFor(doc, event)}
            onkeydown={(event) => handleLauncherKeydown(doc, event)}
            title={`Open ${baseName(doc.name)}`}
          >
            {#if viewerKind(doc) === 'image' && docSource(doc)}
              <img class="attachment-thumb" src={docSource(doc)} alt={doc.title || baseName(doc.name)} />
            {:else}
              <span class="attachment-icon">
                {#each [getFileIcon(doc.name, doc.type || '')] as Icon}
                  <Icon class="h-4 w-4" />
                {/each}
              </span>
            {/if}
            <span class="attachment-copy">
              <span class="attachment-title">{doc.title || baseName(doc.name)}</span>
              <span class="attachment-type">{fileTypeLabel(doc.name, doc.kind)}</span>
            </span>
            {#if allowDownload && viewerKind(doc) !== 'image' && (docSource(doc) || doc.kind === 'slides')}
              <button
                type="button"
                class="attachment-download"
                onclick={(event) => downloadDoc(doc, event)}
                title={`Download ${baseName(doc.name)}`}
                aria-label={`Download ${baseName(doc.name)}`}
              >
                <Download class="h-3.5 w-3.5" />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <div
        class="work-product-tile"
        role="button"
        tabindex="0"
        onclick={openReader}
        onkeydown={handleCapsuleKeydown}
        title="Open {surfaceTitle}"
      >
        <span class="document-icon">
          {#each [primaryIcon] as Icon}
            <Icon class="h-4 w-4" />
          {/each}
        </span>
        <span class="document-copy">
          <span class="document-title">{surfaceTitle}</span>
          <span class="document-subtitle">{subtitle}{#if status !== 'ready'} · {status}{/if}</span>
        </span>
        <span class="document-actions">
          {#if allowDownload && activeDoc && (docSource(activeDoc) || activeDoc.kind === 'slides')}
            <button type="button" class="document-action" onclick={(event) => downloadDoc(activeDoc, event)} title="Download {baseName(activeDoc.name)}">
              <Download class="h-3.5 w-3.5" />
            </button>
          {/if}
          <button type="button" class="document-action" onclick={openReader} title="Open reader">
            <ExternalLink class="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    {/if}

    {#if open}
      <Portal className="document-reader-portal">
        <div class="document-reader-layer" transition:motionFade={{ duration: 120 }}>
          <button class="document-reader-scrim" aria-label="Close reader" onclick={closeReader}></button>
        </div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class={`document-workspace ${viewerKind(activeDoc) === 'image' ? 'image-workspace' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={surfaceTitle}
          tabindex="-1"
          transition:motionFade={{ duration: 120 }}
          onpointerdown={stop}
        >
          {#if viewerKind(activeDoc) !== 'image'}
            <header class="workspace-header">
              <div class="reader-title-wrap">
                <div class="reader-title">{surfaceTitle}</div>
                <div class="reader-subtitle">{subtitle || 'Document'}{#if status !== 'ready'} · {status}{/if}</div>
              </div>
              <div class="workspace-tools">
                {#if canSearch}
                  <label class="workspace-search" title="Search current document">
                    <Search class="h-3.5 w-3.5" />
                    <input bind:value={query} placeholder="Search" />
                    {#if query}
                      <button type="button" class="search-clear" onclick={() => (query = '')} aria-label="Clear search" title="Clear search">
                        <X class="h-3 w-3" />
                      </button>
                    {/if}
                  </label>
                {/if}
                {#if allowDownload && activeDoc && (docSource(activeDoc) || activeDoc.kind === 'slides')}
                  <button type="button" class="reader-icon-btn" onclick={(event) => downloadDoc(activeDoc, event)} aria-label="Download" title="Download">
                    <Download class="h-4 w-4" />
                  </button>
                {/if}
                <button type="button" class="reader-icon-btn" onclick={closeReader} aria-label="Close" title="Close">
                  <X class="h-4 w-4" />
                </button>
              </div>
            </header>
          {:else}
            <button type="button" class="image-viewer-close" onclick={closeReader} aria-label="Close image preview" title="Close">
              <X class="h-5 w-5" />
            </button>
          {/if}

          {#if warnings.length}
            <div class="workspace-warning">
              <AlertCircle class="h-3.5 w-3.5" />
              <span>{warnings[0]}</span>
            </div>
          {/if}

          {#if searchTerm && canSearch}
            <div class="workspace-search-status" class:miss={!searchHit}>
              {#if viewerKind(activeDoc) === 'xlsx'}
                Filtering spreadsheet rows
              {:else if searchMatchCount === 1}
                1 match
              {:else if searchMatchCount > 1}
                {searchMatchCount} matches
              {:else}
                No matches
              {/if}
            </div>
          {/if}

          <div class="reader-body" class:single={visibleDocs.length === 1}>
            {#if visibleDocs.length > 1}
              <nav class="reader-rail" aria-label="Documents">
                {#each visibleDocs as doc (doc.id)}
                  <button
                    type="button"
                    class="reader-file"
                    class:active={activeDoc?.id === doc.id}
                    onclick={() => (activeId = doc.id)}
                  >
                    <span class="reader-file-icon">
                      {#each [getFileIcon(doc.name, doc.type || '')] as Icon}
                        <Icon class="h-3.5 w-3.5" />
                      {/each}
                    </span>
                    <span class="reader-file-copy">
                      <span class="reader-file-title">{doc.title || baseName(doc.name)}</span>
                      <span class="reader-file-type">{fileTypeLabel(doc.name, doc.kind)}</span>
                    </span>
                  </button>
                {/each}
              </nav>
            {/if}

            <main class="reader-preview" bind:this={previewEl}>
              {#if activeDoc}
                {#if activeDoc.kind === 'slides' && activeDoc.slides?.length}
                  <SlidesViewer slides={activeDoc.slides} onDownload={onDownloadSlides || (() => {})} />
                {:else if viewerKind(activeDoc) === 'pdf' && docSource(activeDoc)}
                  <PdfViewer src={docSource(activeDoc)} filename={activeDoc.name} />
                {:else if activeDoc.previewHtml}
                  <iframe class="reader-iframe" srcdoc={safePreviewHtml} sandbox="" referrerpolicy="no-referrer" title="{activeDoc.name} preview"></iframe>
                {:else if isMarkdown(activeDoc)}
                  {#if activeDoc.kind === 'report'}
                    <article class="reader-article">
                      {#each reportSegments(activeDoc.content || '') as segment}
                        {#if segment.kind === 'text'}
                          {#if segment.content.trim()}
                            <div class="markdown-body mb-3">{@html highlightedMarkdown(segment.content)}</div>
                          {/if}
                        {:else}
                          <ChartBlock
                            type={segment.type}
                            title={segment.title}
                            xlabel={segment.xlabel}
                            ylabel={segment.ylabel}
                            raw={segment.raw}
                          />
                        {/if}
                      {/each}
                    </article>
                  {:else}
                    <article class="reader-article markdown-body">
                      {@html highlightedMarkdown(activeDoc.content || '')}
                    </article>
                  {/if}
                {:else if viewerKind(activeDoc) === 'pdf'}
                  <PdfViewer src={docSource(activeDoc)} filename={activeDoc.name} />
                {:else if viewerKind(activeDoc) === 'docx'}
                  <DocxViewer src={docSource(activeDoc)} filename={activeDoc.name} />
                {:else if viewerKind(activeDoc) === 'xlsx'}
                  <XlsxViewer src={docSource(activeDoc)} filename={activeDoc.name} query={query} />
                {:else if viewerKind(activeDoc) === 'text'}
                  <TextViewer src={docSource(activeDoc)} filename={activeDoc.name} query={query} />
                {:else if viewerKind(activeDoc) === 'image'}
                  <div class="reader-image-stage">
                    {#if docSource(activeDoc)}
                      <img class="reader-image" src={docSource(activeDoc)} alt={activeDoc.title || baseName(activeDoc.name)} />
                    {:else}
                      <div class="reader-empty">Image preview is not available for this file.</div>
                    {/if}
                  </div>
                {:else if viewerKind(activeDoc) === 'pptx'}
                  <div class="reader-empty">
                    <Files class="h-5 w-5" />
                    <span>PPTX preview is not available for this file. Download it to open the deck.</span>
                  </div>
                {:else}
                  <div class="reader-empty">Preview not available for this file type.</div>
                {/if}
              {/if}
            </main>
          </div>
        </div>
      </Portal>
    {/if}
  </div>
{/if}

<style>
  .document-surface {
    margin-top: 0.55rem;
  }

  .attachment-strip {
    display: flex;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: stretch;
  }

  .attachment-launcher {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
    width: min(17rem, 100%);
    min-width: 0;
    max-width: 100%;
    min-height: 3.15rem;
    padding: 0.5rem 0.6rem;
    border: 0;
    /* The composer's card language: white, hairline ring, generous corner. */
    border-radius: var(--radius-xl);
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--composer-ring);
    text-align: left;
    transition: background 150ms ease, box-shadow 150ms ease;
  }

  .attachment-launcher:hover {
    background: var(--muted);
    box-shadow: inset 0 0 0 1px var(--composer-ring-focus);
  }

  .attachment-launcher:focus-visible {
    outline: none;
    box-shadow: var(--artifact-focus);
  }

  .attachment-launcher.attachment-image {
    display: block;
    width: fit-content;
    min-width: 0;
    max-width: min(18rem, 100%);
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-lg);
    background: transparent;
    overflow: hidden;
  }

  .attachment-launcher.attachment-image:hover {
    background: transparent;
  }

  .attachment-launcher.attachment-image .attachment-copy {
    display: none;
  }

  .attachment-thumb,
  .attachment-icon {
    display: inline-flex;
    width: 2.35rem;
    height: 2.35rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
    color: var(--text-secondary);
    object-fit: cover;
    overflow: hidden;
  }

  .attachment-launcher.attachment-image .attachment-thumb {
    display: block;
    width: auto;
    max-width: min(18rem, 100%);
    max-height: 14rem;
    height: auto;
    border-radius: var(--radius-lg);
    background: transparent;
    object-fit: contain;
  }

  .attachment-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.1rem;
  }

  .attachment-title,
  .attachment-type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-title {
    color: var(--text);
    font-size: 0.77rem;
    font-weight: 550;
  }

  .attachment-type {
    color: var(--text-muted);
    font-size: 0.65rem;
  }

  .attachment-download {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    transition: background 150ms ease, color 150ms ease;
  }

  .attachment-download:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .work-product-tile {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    width: min(21rem, 100%);
    min-height: 3.35rem;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    padding: 0.6rem 0.7rem;
    text-align: left;
    transition: background 150ms ease, box-shadow 150ms ease;
  }

  .work-product-tile:hover {
    background: var(--artifact-surface-hover);
  }

  .work-product-tile:focus-visible {
    outline: none;
    box-shadow: var(--artifact-focus);
  }

  .document-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
    color: var(--text-secondary);
  }

  .document-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.12rem;
  }

  .document-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 600;
  }

  .document-subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 450;
  }

  .document-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
  }

  .document-action,
  .reader-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.95rem;
    height: 1.95rem;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    background: transparent;
    transition: background 150ms ease, color 150ms ease;
  }

  .document-action:hover,
  .reader-icon-btn:hover {
    color: var(--text);
    background: var(--artifact-surface-hover);
  }

  .document-action:focus-visible,
  .reader-icon-btn:focus-visible {
    outline: none;
    box-shadow: var(--artifact-focus);
  }

  .document-reader-layer {
    position: fixed;
    inset: 0;
    z-index: 10000;
    pointer-events: none;
  }

  .document-reader-scrim {
    position: absolute;
    inset: 0;
    pointer-events: auto;
    background: color-mix(in srgb, #000 42%, transparent);
  }

  .document-workspace {
    position: fixed;
    inset: 1.5vh 1.5vw;
    z-index: 10001;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 0;
    /* Same white card and corner as the composer, so the viewer reads as part
       of the same surface family rather than a tinted panel. */
    border-radius: var(--composer-radius);
    background: var(--card);
    box-shadow:
      inset 0 0 0 1px var(--composer-ring),
      var(--shadow-xl);
  }

  .workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 0;
    padding: 0.7rem 0.85rem;
    background: color-mix(in srgb, var(--artifact-surface) 70%, transparent);
  }

  .reader-title-wrap {
    min-width: 0;
  }

  .reader-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 650;
  }

  .reader-subtitle {
    color: var(--text-muted);
    font-size: 0.68rem;
    margin-top: 0.05rem;
  }

  .workspace-tools {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .workspace-search {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    width: min(14rem, 28vw);
    height: 2rem;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 0 0.6rem;
    color: var(--text-secondary);
    background: var(--artifact-surface-hover);
  }

  .workspace-search:focus-within {
    box-shadow: var(--artifact-focus);
  }

  .workspace-search input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font-size: 0.75rem;
  }

  .search-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    border-radius: 999px;
    color: var(--text-tertiary);
  }

  .search-clear:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .workspace-warning,
  .workspace-search-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-bottom: 0;
    padding: 0.45rem 1rem;
    color: var(--text-secondary);
    font-size: 0.72rem;
    background: color-mix(in srgb, var(--artifact-surface-hover) 55%, transparent);
  }

  .workspace-search-status.miss {
    color: var(--text-tertiary);
  }

  .reader-body {
    display: grid;
    grid-template-columns: minmax(10rem, 13rem) minmax(0, 1fr);
    min-height: 0;
    flex: 1;
  }

  .reader-rail {
    overflow: auto;
    border-right: 0;
    padding: 0.45rem;
    background: color-mix(in srgb, var(--artifact-surface) 80%, transparent);
  }

  .reader-file {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 0.5rem;
    text-align: left;
    color: var(--text-secondary);
    transition: background 0.14s ease, color 0.14s ease;
  }

  .reader-file:hover,
  .reader-file.active {
    background: var(--artifact-surface-hover);
    color: var(--text);
  }

  .reader-file:focus-visible {
    outline: none;
    box-shadow: var(--artifact-focus);
  }

  .reader-file-icon {
    display: inline-flex;
    width: 1.35rem;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
  }

  .reader-file-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .reader-file-title,
  .reader-file-type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reader-file-title {
    color: var(--text);
    font-size: 0.75rem;
    font-weight: 550;
  }

  .reader-file-type {
    color: var(--text-muted);
    font-size: 0.625rem;
  }

  .reader-preview {
    min-width: 0;
    overflow: auto;
    background: var(--chat-bg);
    padding: 0.85rem 1rem;
  }

  .image-workspace {
    inset: 3vh 3vw;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    box-shadow: none;
    overflow: visible;
  }

  .image-workspace .reader-body,
  .image-workspace .reader-preview {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    align-items: center;
    justify-content: center;
    background: transparent;
    overflow: visible;
    padding: 0;
  }

  .image-viewer-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.35rem;
    height: 2.35rem;
    border-radius: 9999px;
    background: color-mix(in srgb, black 48%, transparent);
    color: white;
    backdrop-filter: blur(10px);
    transition: background 0.15s ease, transform 0.15s ease;
  }

  .image-viewer-close:hover {
    background: color-mix(in srgb, black 62%, transparent);
    transform: scale(1.03);
  }

  .reader-preview :global(mark) {
    border-radius: 2px;
    background: color-mix(in srgb, var(--primary) 22%, transparent);
    color: inherit;
    padding: 0 0.08rem;
  }

  .reader-body.single {
    grid-template-columns: minmax(0, 1fr);
  }

  .reader-article {
    width: min(56rem, 100%);
    margin: 0 auto;
    color: var(--text);
    font-size: 0.95rem;
    line-height: 1.68;
  }

  .reader-iframe {
    width: 100%;
    height: calc(96vh - 7.5rem);
    border: 0;
    background: #fff;
  }

  .reader-image-stage {
    display: flex;
    min-height: calc(96vh - 9rem);
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
  }

  .reader-image {
    display: block;
    max-width: 100%;
    max-height: calc(96vh - 10rem);
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
  }

  .image-workspace .reader-image-stage {
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
  }

  .image-workspace .reader-image {
    max-width: 100%;
    max-height: 94vh;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xl);
  }

  .reader-empty {
    display: flex;
    min-height: 18rem;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  @media (max-width: 760px) {
    .document-workspace {
      inset: 0;
      border-radius: 0;
    }

    .workspace-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .workspace-tools,
    .workspace-search {
      width: 100%;
    }

    .reader-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }

    .attachment-launcher {
      max-width: 100%;
      min-width: min(100%, 14rem);
      width: 100%;
    }

    .reader-rail {
      display: flex;
      gap: 0.35rem;
      border-right: 0;
      border-bottom: 0;
      overflow-x: auto;
      padding: 0.45rem;
      background: color-mix(in srgb, var(--artifact-surface) 80%, transparent);
    }

    .reader-file {
      width: min(13rem, 72vw);
      flex-shrink: 0;
    }
  }
</style>
