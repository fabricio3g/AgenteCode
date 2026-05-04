<svelte:options runes={true} />

<script lang="ts">
  import { Loader2, AlertCircle } from 'lucide-svelte';

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
      const mammoth = await import('mammoth');
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      htmlContent = buildPreviewFrame(result.value);
    } catch (err) {
      console.error('[DocxViewer] Failed to convert DOCX:', err);
      error = 'Failed to preview document';
    } finally {
      loading = false;
    }
  }

  function buildPreviewFrame(bodyHtml: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Inter,Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.65;color:#172033;background:#fff;padding:32px 40px}
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
  {#if loading}
    <div class="docx-status">
      <Loader2 class="h-4 w-4 animate-spin" />
      <span>Converting document...</span>
    </div>
  {:else if error}
    <div class="docx-status error">
      <AlertCircle class="h-4 w-4" />
      <span>{error}</span>
    </div>
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
    flex-direction: column;
  }

  .docx-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .docx-status.error {
    color: var(--error);
  }

  .docx-frame {
    overflow: hidden;
    background: var(--surface);
  }

  .docx-iframe {
    width: 100%;
    height: clamp(18rem, 48vh, 32rem);
    border: 0;
    background: #fff;
  }
</style>
