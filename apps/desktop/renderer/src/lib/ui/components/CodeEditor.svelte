<svelte:options runes={true} />

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type * as Monaco from 'monaco-editor';
  import { accessibilityStore } from '$lib/stores/accessibility.svelte';
  import { codeFontFamily, codeFontSize } from '$lib/utils/type-tokens';

  interface Props {
    value?: string;
    language?: string;
    readOnly?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = '', language = 'plaintext', readOnly = false, onchange }: Props = $props();

  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  let editor = $state.raw<Monaco.editor.IStandaloneCodeEditor>();
  let monaco: typeof Monaco | undefined;
  let destroyed = false;
  let themeObserver: MutationObserver | undefined;
  let contentListener: Monaco.IDisposable | undefined;
  let loadError = $state(false);
  let ignoreNextChange = false;

  function getMonacoLanguage(lang: string): string {
    const map: Record<string, string> = {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      jsx: 'javascript',
      tsx: 'typescript',
      html: 'html',
      htm: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      py: 'python',
      json: 'json',
      jsonl: 'json',
      md: 'markdown',
      markdown: 'markdown',
      xml: 'xml',
      svg: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'ini',
      sh: 'shell',
      bash: 'shell',
      zsh: 'shell',
      ps1: 'powershell',
      rb: 'ruby',
      rs: 'rust',
      go: 'go',
      java: 'java',
      c: 'c',
      cc: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      sql: 'sql',
      php: 'php',
      lua: 'lua',
      r: 'r',
      rscript: 'r'
    };
    return map[lang.toLowerCase()] || 'plaintext';
  }

  function getTheme(): 'vs' | 'vs-dark' {
    return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
  }

  async function initializeEditor() {
    if (!containerEl) return;

    monaco = await import('monaco-editor');
    if (destroyed || !containerEl) return;
    editor = monaco.editor.create(containerEl, {
      value,
      language: getMonacoLanguage(language),
      theme: getTheme(),
      readOnly,
      minimap: { enabled: false },
      fontSize: codeFontSize(),
      fontFamily: codeFontFamily(),
      // Off by default, like VS Code: a ligature merges `!=` into one glyph,
      // which is exactly the shape a reader has to tell apart in a diff.
      fontLigatures: false,
      lineNumbers: 'on',
      lineNumbersMinChars: 4,
      roundedSelection: true,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      suggest: { showIcons: true },
      quickSuggestions: !readOnly,
      parameterHints: { enabled: !readOnly },
      folding: true,
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      matchBrackets: 'always',
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      padding: { top: 12, bottom: 12 },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false
      },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      contextmenu: true,
      mouseWheelZoom: false,
      accessibilitySupport: 'auto'
    });

    contentListener = editor.onDidChangeModelContent(() => {
      if (ignoreNextChange || readOnly) return;
      const newValue = editor?.getValue() || '';
      onchange?.(newValue);
    });

    themeObserver = new MutationObserver(() => {
      monaco?.editor.setTheme(getTheme());
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  onMount(() => {
    void initializeEditor().catch((error) => {
      console.warn('[CodeEditor] Falling back to plain text:', error);
      if (!destroyed) loadError = true;
    });
  });

  onDestroy(() => {
    destroyed = true;
    themeObserver?.disconnect();
    contentListener?.dispose();
    const model = editor?.getModel();
    editor?.dispose();
    model?.dispose();
  });

  // Text size and reading font reach the canvas through the tokens.
  $effect(() => {
    void accessibilityStore.prefs.textScale;
    void accessibilityStore.prefs.font;
    editor?.updateOptions({ fontSize: codeFontSize(), fontFamily: codeFontFamily() });
  });

  $effect(() => {
    if (editor && value !== editor.getValue()) {
      ignoreNextChange = true;
      editor.setValue(value);
      ignoreNextChange = false;
    }
  });

  $effect(() => {
    if (editor && monaco) {
      const model = editor.getModel();
      const newLang = getMonacoLanguage(language);
      if (model) {
        monaco.editor.setModelLanguage(model, newLang);
      }
    }
  });

  $effect(() => {
    if (editor) {
      editor.updateOptions({ readOnly });
    }
  });
</script>

{#if loadError}
  <textarea class="h-full w-full resize-none bg-background p-3 font-mono text-xs text-foreground" aria-label="Source code" {value} readonly={readOnly} oninput={(event) => onchange?.(event.currentTarget.value)} spellcheck="false"></textarea>
{:else}
  <div bind:this={containerEl} class="monaco-container"></div>
{/if}

<style>
  .monaco-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
