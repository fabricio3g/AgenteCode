<svelte:options runes={true} />

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { readArrayBuffer } from './viewer-source';
  import { escapeHtml } from './viewer-text';

  import { createViewerFind } from './viewer-find.svelte';
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
  let contentNode = $state<HTMLElement>();
  let revision = $state(0);
  const find = createViewerFind(() => contentNode, () => term);
  registerViewerControls(controls, () => ({
    search: { matches: find.state.matches, index: find.state.index, step: find.step }, retry: error ? () => { revision += 1; } : undefined,
    actions: [{ label: $t('viewer.wrap'), active: wrap, run: () => { wrap = !wrap; } }]
  }));


  let loading = $state(true);
  let error = $state<string | null>(null);
  let textContent = $state('');
  let highlightedHtml = $state('');

  // With a search term the raw text is escaped and marked; without one the
  // syntax-highlighted HTML from hljs is preferred when it is available.
  const renderedHtml = $derived(highlightedHtml || escapeHtml(textContent));
  async function loadText(source: string, language: string, current: () => boolean) {
    loading = true; error = null; textContent = ''; highlightedHtml = '';
    try {
      const bytes = new Uint8Array(await readArrayBuffer(source, 'file'));
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      const text = new TextDecoder(encoding).decode(bytes);
      if (!current()) return;
      textContent = text;
      if (language && text && text.length < 500_000) {
        try {
          const { default: hljs } = await import('highlight.js/lib/common');
          if (current() && hljs.getLanguage(language)) highlightedHtml = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch { /* Plain text remains readable. */ }
      }
    } catch (failure) { if (current()) error = failure instanceof Error ? failure.message : 'Failed to load file'; }
    finally { if (current()) loading = false; }
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
    const source = src, language = lang || guessLanguage(filename, ''); revision;
    let current = true;
    void loadText(source, language, () => current);
    return () => { current = false; };
  });
</script>

<div class="text-viewer">
  {#if loading || error}
    <ViewerStatus {loading} {error} label={copy.viewer.loadingFile} retry={error ? () => { revision += 1; } : undefined} />
  {:else}
    <div class="text-frame">
      <pre class="text-pre" class:wrap><code bind:this={contentNode} data-viewer-text>{@html renderedHtml}</code></pre>
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
    font-family: var(--font-mono);
    font-size: var(--text-code);
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
