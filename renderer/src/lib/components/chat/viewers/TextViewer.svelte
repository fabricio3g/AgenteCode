<svelte:options runes={true} />

<script lang="ts">
  import { Loader2, AlertCircle, FileText } from 'lucide-svelte';

  interface Props {
    src: string;
    filename: string;
    lang?: string;
    query?: string;
  }

  let { src, filename, lang = '', query = '' }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let textContent = $state('');
  let highlightedHtml = $state('');

  const renderedHtml = $derived.by(() => {
    const term = query.trim();
    const rawHtml = term ? escapeHtml(textContent) : (highlightedHtml || escapeHtml(textContent));
    if (!term) return rawHtml;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return rawHtml.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  });

  function escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function loadText() {
    loading = true;
    error = null;
    textContent = '';
    highlightedHtml = '';
    try {
      const response = await fetch(src);
      const text = await response.text();
      textContent = text;

      if (lang && text) {
          try {
            const { default: hljs } = await import('highlight.js');
            const result = hljs.highlight(text, { language: lang, ignoreIllegals: true });
            highlightedHtml = result.value;
          } catch {
            highlightedHtml = '';
          }
      }
    } catch (err) {
      console.error('[TextViewer] Failed to load text:', err);
      error = 'Failed to load file';
    } finally {
      loading = false;
    }
  }

  function guessLanguage(name: string, mime: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', ts: 'typescript', py: 'python',
      rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      cpp: 'cpp', c: 'c', cs: 'csharp', php: 'php',
      swift: 'swift', kt: 'kotlin', scala: 'scala',
      sh: 'bash', bash: 'bash', zsh: 'bash',
      html: 'html', htm: 'html', css: 'css', scss: 'scss',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', markdown: 'markdown',
      sql: 'sql', r: 'r', lua: 'lua', pl: 'perl',
      toml: 'ini', ini: 'ini', cfg: 'ini',
      diff: 'diff', patch: 'diff',
      svg: 'xml', env: 'ini',
    };
    return langMap[ext] || '';
  }

  $effect(() => {
    if (src) {
      if (!lang) lang = guessLanguage(filename, '');
      loadText();
    }
  });
</script>

<div class="text-viewer">
  {#if loading}
    <div class="text-status">
      <Loader2 class="h-4 w-4 animate-spin" />
      <span>Loading file...</span>
    </div>
  {:else if error}
    <div class="text-status error">
      <AlertCircle class="h-4 w-4" />
      <span>{error}</span>
    </div>
  {:else}
    <div class="text-frame">
      <pre class="text-pre"><code>{@html renderedHtml}</code></pre>
    </div>
    {#if textContent.length > 50000}
      <div class="text-truncated">
        <FileText class="h-3.5 w-3.5" />
        <span>Showing first 50,000 characters of {textContent.length.toLocaleString()}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .text-viewer {
    display: flex;
    flex-direction: column;
  }

  .text-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .text-status.error {
    color: var(--error);
  }

  .text-frame {
    background: #0d1117;
    overflow: auto;
    max-height: 28rem;
  }

  .text-pre {
    margin: 0;
    padding: 1rem;
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.75rem;
    line-height: 1.55;
    color: #e6edf3;
    white-space: pre;
    tab-size: 2;
  }

  .text-pre code {
    font-family: inherit;
    background: none;
    padding: 0;
  }

  .text-pre :global(mark) {
    border-radius: 2px;
    background: color-mix(in srgb, var(--primary) 30%, transparent);
    color: inherit;
    padding: 0 0.08rem;
  }

  .text-truncated {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }
</style>
