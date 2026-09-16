<svelte:options runes={true} />

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';

  interface Props {
    src: string;
    filename: string;
  }

  let { src, filename }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let htmlContent = $state('');

  async function convertDocx(source: string, name: string, isCurrent: () => boolean) {
    loading = true;
    error = null;
    htmlContent = '';
    try {
      if (!/\.docx$/i.test(name)) {
        throw new Error('Only DOCX preview is supported. Download this document to open it.');
      }
      const mammothModule = await import('mammoth');
      const mammoth = (mammothModule as any).default || mammothModule;
      const arrayBuffer = await readArrayBuffer(source);
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (isCurrent()) htmlContent = buildPreviewHtml(buildPreviewFrame(result.value || '<p>This document has no readable text.</p>'), {}, 'index.html').html;
    } catch (err) {
      console.error('[DocxViewer] Failed to convert DOCX:', err);
      if (isCurrent()) error = err instanceof Error ? err.message : 'Document preview is unavailable. Download it to open.';
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  function buildPreviewFrame(bodyHtml: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      html{background:#e8ecf2}
      body{font-family:Inter,Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.68;color:#172033;background:#fff;max-width:880px;margin:12px auto 28px;padding:30px 38px;border-radius:8px;box-shadow:0 1px 3px rgb(15 23 42 / 0.12)}
      h1{font-size:28px;margin:0 0 20px;color:#0f172a}
      h2{font-size:22px;margin:24px 0 12px;color:#1e293b}
      h3{font-size:18px;margin:20px 0 10px;color:#334155}
      p{margin:0 0 12px;white-space:pre-wrap}
      ul,ol{margin:0 0 12px;padding-left:24px}
      li{margin:4px 0}
      table{border-collapse:collapse;margin:12px 0;width:100%;font-size:13px}
      th,td{border:1px solid #d8e0ea;padding:7px 10px;text-align:left;vertical-align:top}
      th{background:#eef2f7;font-weight:600;color:#334155}
      img{max-width:100%;height:auto;margin:12px 0}
      blockquote{border-left:3px solid #d8e0ea;padding:6px 16px;margin:12px 0;color:#64748b}
      code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px;font-family:monospace}
      pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px;overflow-x:auto;margin:12px 0}
      pre code{background:none;padding:0}
    </style></head><body>${bodyHtml}</body></html>`;
  }

  $effect(() => {
    let current = true;
    void convertDocx(src, filename, () => current);
    return () => { current = false; };
  });
</script>

<div class="docx-viewer">
  {#if loading || error}
    <ViewerStatus
      {loading}
      {error}
      label={copy.viewer.convertingDocument}
      variant="card"
      errorTitle={copy.viewer.previewUnavailable}
    />
  {:else if htmlContent}
    <div class="docx-frame">
      <iframe
        class="docx-iframe"
        srcdoc={htmlContent}
        sandbox=""
        referrerpolicy="no-referrer"
        title="{filename} preview"
      ></iframe>
    </div>
  {/if}
</div>

<style>
  .docx-viewer {
    display: flex;
    min-height: 100%;
    flex-direction: column;
  }

  .docx-frame {
    min-height: 100%;
    overflow: hidden;
    /* The sheet lives inside the document (paper on muted backdrop) — no
       outer card, or whitespace stacks three deep. */
    background: transparent;
  }

  .docx-iframe {
    width: 100%;
    height: calc(97vh - 6.5rem);
    border: 0;
    background: transparent;
  }
</style>
