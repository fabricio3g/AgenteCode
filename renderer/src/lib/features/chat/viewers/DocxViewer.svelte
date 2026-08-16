<svelte:options runes={true} />

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';

  interface Props {
    src: string;
    filename: string;
  }

  let { src, filename }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let htmlContent = $state('');

  async function convertDocx() {
    loading = true;
    error = null;
    htmlContent = '';
    try {
      if (!/\.docx$/i.test(filename)) {
        throw new Error('Only DOCX preview is supported. Download this document to open it.');
      }
      const mammothModule = await import('mammoth');
      const mammoth = (mammothModule as any).default || mammothModule;
      const arrayBuffer = await readArrayBuffer(src);
      const result = await mammoth.convertToHtml({ arrayBuffer });
      htmlContent = buildPreviewFrame(result.value || '<p>This document has no readable text.</p>');
    } catch (err) {
      console.error('[DocxViewer] Failed to convert DOCX:', err);
      error = err instanceof Error ? err.message : 'Document preview is unavailable. Download it to open.';
    } finally {
      loading = false;
    }
  }

  function buildPreviewFrame(bodyHtml: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Inter,Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.68;color:#172033;background:#fff;padding:28px 36px;max-width:920px;margin:0 auto}
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
    if (src) convertDocx();
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
        sandbox="allow-scripts allow-same-origin"
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
    border-radius: var(--radius-lg);
    background: #fff;
    box-shadow: var(--shadow-xs);
  }

  .docx-iframe {
    width: 100%;
    height: calc(97vh - 6.5rem);
    border: 0;
    background: #fff;
  }
</style>
