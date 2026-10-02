<svelte:options runes={true} />

<!--
  A real preview of an artifact for the library grid: the first slide of a
  deck, the first page of a Word document or PDF, the top-left of a sheet,
  the chart or card itself, or the web page. Loads only once `visible`.
-->

<script lang="ts">
  import { FileText, Files } from 'lucide-svelte';
  import type { AgentArtifact } from '$lib/types/chat';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { artifactDocumentItems, type DocumentSurfaceItem } from '$lib/features/chat/document-surface';
  import { documentSource } from '$lib/features/chat/document-viewer';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { renderMarkdown } from '$lib/utils/markdown';
  import InlineArtifactPreview from '$lib/ui/components/InlineArtifactPreview.svelte';
  import DeckSlideView from '$lib/features/chat/viewers/DeckSlideView.svelte';
  import { readArrayBuffer } from '$lib/features/chat/viewers/viewer-source';
  import { columnName, rawCell, sheetToGrid, type GridSheet } from '$lib/features/chat/viewers/xlsx-model';
  import { createFormulaEvaluator, type CellInput } from '$lib/features/chat/viewers/xlsx-formula';
  import { renderPptx } from '$lib/features/chat/viewers/pptx-render';
  import { loadDocxInto } from '$lib/features/chat/viewers/docx-pages';

  let { artifact, visible }: { artifact: AgentArtifact; visible: boolean } = $props();

  const resolved = $derived(resolveArtifactPresentation(artifact));
  const inline = $derived(resolved.manifest.presentation === 'inline' && !!resolved.artifact.inline);
  const doc = $derived.by((): DocumentSurfaceItem | null => {
    const docs = resolved.manifest.presentation === 'document' ? artifactDocumentItems(resolved) : [];
    return docs.find((item) => item.id === resolved.manifest.entryPath) ?? docs[0] ?? null;
  });
  const ext = $derived((doc?.name.split('.').pop() || '').toLowerCase());
  const pageHtml = $derived.by(() => {
    if (inline || doc || !resolved.preview) return '';
    try {
      return buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath).html;
    } catch {
      return '';
    }
  });

  let imageUrl = $state('');
  let sheet = $state<GridSheet | null>(null);
  let docxHost = $state<HTMLDivElement>();
  let docxReady = $state(false);
  let failed = $state(false);

  // Heavy previews (PDF, sheets, Word, imported decks) load once, when shown.
  $effect(() => {
    if (!visible || !doc || failed) return;
    const source = documentSource(doc);
    let revoke = '';
    let live = true;
    const done = (fn: () => void) => { if (live) fn(); };
    (async () => {
      try {
        if (ext === 'pdf' && source) {
          const pdfjs = await import('pdfjs-dist');
          const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
          const pdf = await pdfjs.getDocument({ data: await readArrayBuffer(source, 'document') }).promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 0.8 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas }).promise;
          done(() => (imageUrl = canvas.toDataURL('image/png')));
        } else if (ext === 'pptx' && !doc.deck && source) {
          const deck = await renderPptx(source);
          revoke = deck.slides[0]?.url ?? '';
          // Keep only the first slide's URL alive.
          deck.slides.slice(1).forEach((slide) => URL.revokeObjectURL(slide.url));
          done(() => (imageUrl = revoke));
        } else if (ext === 'xlsx' && source) {
          const ExcelJS = await import('exceljs');
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(await readArrayBuffer(source, 'spreadsheet'));
          const first = workbook.worksheets.find((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
          const evaluator = createFormulaEvaluator((name, row, col) => rawCell(workbook.getWorksheet(name), row, col) as CellInput);
          if (first) done(() => (sheet = sheetToGrid(first, 'en', { minRows: 14, minCols: 7 }, (formula, row, col) => evaluator.evaluateCell(formula, first.name, row, col))));
        } else if (ext === 'docx' && source && docxHost) {
          const pending = document.createElement('div');
          await loadDocxInto(source, doc.name, pending);
          const page = pending.querySelector('section.docx');
          if (page && docxHost) {
            docxHost.replaceChildren(...Array.from(pending.querySelectorAll('style')), page);
            done(() => (docxReady = true));
          }
        }
      } catch {
        done(() => (failed = true));
      }
    })();
    return () => {
      live = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  });
</script>

<div class="thumb">
  {#if inline}
    <!-- The chart or card itself, drawn at twice the size and shrunk. -->
    <div class="scaled" aria-hidden="true"><InlineArtifactPreview artifact={resolved.artifact} /></div>
  {:else if doc?.deck}
    <div class="slide-fit"><DeckSlideView deck={doc.deck} slide={doc.deck.slides[0]} index={0} /></div>
  {:else if imageUrl}
    <img class="page-img" class:is-slide={ext === 'pptx'} src={imageUrl} alt="" />
  {:else if sheet}
    <table class="mini-sheet" aria-hidden="true">
      <thead><tr><th></th>{#each Array(Math.min(sheet.cols, 7)) as _, c (c)}<th>{columnName(c)}</th>{/each}</tr></thead>
      <tbody>
        {#each sheet.cells.slice(0, 14) as row, r (r)}
          <tr>
            <th>{r + 1}</th>
            {#each row.slice(0, 7) as cell, c (c)}
              {#if !cell.covered}
                <td colspan={cell.span ? Math.min(cell.span.cols, 7 - c) : undefined} style:background={cell.style.fill} style:color={cell.style.color ?? (cell.style.fill ? '#1b1b1f' : undefined)} style:font-weight={cell.style.bold ? 600 : undefined} style:text-align={cell.style.align}>{cell.text}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if ext === 'docx'}
    <div class="docx-page" class:ready={docxReady} bind:this={docxHost}></div>
    {#if !docxReady}<span class="glyph"><FileText class="size-8" /></span>{/if}
  {:else if doc && (ext === 'md' || ext === 'markdown') && doc.content}
    <article class="md-page markdown-body">{@html renderMarkdown(doc.content.slice(0, 1800))}</article>
  {:else if doc?.content}
    <pre class="text-page">{doc.content.slice(0, 600)}</pre>
  {:else if pageHtml && visible}
    <iframe class="web" srcdoc={pageHtml} sandbox="" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true" title=""></iframe>
  {:else}
    <span class="glyph">{#if doc}<FileText class="size-8" />{:else}<Files class="size-8" />{/if}</span>
  {/if}
</div>

<style>
  .thumb {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
  }
  .glyph {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    opacity: 0.6;
  }
  .scaled {
    width: 200%;
    transform: scale(0.5);
    transform-origin: top left;
    padding: 1rem 1.25rem;
  }
  .slide-fit {
    position: absolute;
    inset: 12% 10%;
    display: flex;
    align-items: center;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.12), 0 6px 18px rgb(0 0 0 / 0.08);
  }
  .slide-fit :global(.deck-slide) {
    width: 100%;
  }
  .page-img {
    position: absolute;
    left: 50%;
    top: 10%;
    width: 62%;
    transform: translateX(-50%);
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.12), 0 6px 18px rgb(0 0 0 / 0.08);
  }
  .page-img.is-slide {
    top: 12%;
    width: 80%;
  }
  .docx-page {
    position: absolute;
    left: 50%;
    top: 10%;
    width: 816px;
    transform: translateX(-50%) scale(0.28);
    transform-origin: top center;
    visibility: hidden;
  }
  .docx-page.ready {
    visibility: visible;
  }
  .docx-page :global(section.docx) {
    margin: 0 !important;
    background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.1) !important;
  }
  .mini-sheet {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 10px;
    font-family: Calibri, Carlito, 'Segoe UI', Inter, sans-serif;
    background: var(--background);
    color: var(--foreground);
  }
  .mini-sheet th,
  .mini-sheet td {
    height: 17px;
    padding: 0 4px;
    border-right: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
    overflow: hidden;
    white-space: nowrap;
  }
  .mini-sheet th {
    width: 22px;
    background: var(--muted);
    color: var(--muted-foreground);
    font-weight: 500;
    text-align: center;
  }
  .mini-sheet thead th:not(:first-child) {
    width: auto;
  }
  .md-page,
  .text-page {
    position: absolute;
    left: 12%;
    right: 12%;
    top: 10%;
    bottom: -10%;
    padding: 1rem 1.1rem;
    overflow: hidden;
    background: var(--background);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.1), 0 6px 18px rgb(0 0 0 / 0.06);
    font-size: 7px;
    line-height: 1.5;
    color: var(--foreground);
  }
  .md-page :global(h1) { font-size: 12px; margin: 0 0 6px; }
  .md-page :global(h2) { font-size: 9px; margin: 8px 0 4px; }
  .md-page :global(p),
  .md-page :global(li) { margin: 0 0 4px; }
  .text-page {
    font-family: var(--font-mono, ui-monospace, monospace);
    white-space: pre-wrap;
    margin: 0;
  }
  .web {
    position: absolute;
    top: 0;
    left: 0;
    width: 400%;
    height: 400%;
    border: 0;
    background: white;
    transform: scale(0.25);
    transform-origin: top left;
  }
</style>
