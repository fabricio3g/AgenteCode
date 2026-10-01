<svelte:options runes={true} />

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';
  import { escapeHtml, highlightTerm } from './viewer-text';

  import { registerViewerControls, useViewerControls } from './viewer-controls.svelte';
  const controls = useViewerControls();
  let wrap = $state(false);
  import { t } from 'svelte-i18n';

  interface Props {
    src: string;
    filename: string;
    lang?: string;
    query?: string;
  }

  let { src, filename, lang = '', query = '' }: Props = $props();
  const term = $derived(query || controls?.query || '');
  registerViewerControls(controls, () => ({
    search: { matches: term.trim() ? textContent.toLowerCase().split(term.trim().toLowerCase()).length - 1 : 0, index: 0 },
    actions: [{ label: $t('viewer.wrap'), active: wrap, run: () => { wrap = !wrap; } }]
  }));


  let loading = $state(true);
  let error = $state<string | null>(null);
  let textContent = $state('');
  let highlightedHtml = $state('');

  // With a search term the raw text is escaped and marked; without one the
  // syntax-highlighted HTML from hljs is preferred when it is available.
  const renderedHtml = $derived.by(() => {
    if (!term.trim()) return highlightedHtml || escapeHtml(textContent);
    return highlightTerm(textContent, term);
  });

  async function loadText() {
    loading = true;
    error = null;
    textContent = '';
    highlightedHtml = '';
    try {
      // Not fetch(): the app's CSP blocks fetching data: URLs.
      const text = new TextDecoder().decode(await readArrayBuffer(src, 'file'));
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
  {#if loading || error}
    <ViewerStatus {loading} {error} label={copy.viewer.loadingFile} />
  {:else}
    <div class="text-frame">
      <pre class="text-pre" class:wrap><code>{@html renderedHtml}</code></pre>
    </div>

  {/if}
</div>

<style>
  .text-viewer {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }



  .text-frame {
    background: var(--background);
    flex: 1;
    min-height: 0;
    overflow: auto;

  }

  .text-pre {
    margin: 0;
    padding: 1rem;
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--foreground);
    white-space: pre;
    tab-size: 2;
  }

  .text-pre.wrap { white-space:pre-wrap; overflow-wrap:anywhere; }
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

</style>
