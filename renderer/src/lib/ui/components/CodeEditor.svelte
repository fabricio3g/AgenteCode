<svelte:options runes={true} />

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type * as Monaco from 'monaco-editor';

  interface Props {
    value?: string;
    language?: string;
    readOnly?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = '', language = 'plaintext', readOnly = false, onchange }: Props = $props();

  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let monaco: typeof Monaco | undefined;
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
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
    }
    return 'vs-dark';
  }

  onMount(async () => {
    if (!containerEl) return;

    monaco = await import('monaco-editor');
    if (!containerEl) return;  // Guard: component may have been destroyed during async import
    editor = monaco.editor.create(containerEl, {
      value,
      language: getMonacoLanguage(language),
      theme: getTheme(),
      readOnly,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontLigatures: true,
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
      mouseWheelZoom: true,
      accessibilitySupport: 'auto'
    });

    if (!readOnly) {
      editor.onDidChangeModelContent(() => {
        if (ignoreNextChange) return;
        const newValue = editor?.getValue() || '';
        onchange?.(newValue);
      });
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleThemeChange = () => {
      monaco?.editor.setTheme(getTheme());
    };
    mediaQuery.addEventListener('change', handleThemeChange);
  });

  onDestroy(() => {
    // Remove Monaco's DOM node before disposal to prevent parentNode access on detached nodes
    const domNode = editor?.getDomNode();
    if (domNode) domNode.remove();
    if (containerEl) containerEl.innerHTML = '';
    editor?.dispose();
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

<div bind:this={containerEl} class="monaco-container"></div>

<style>
  .monaco-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
