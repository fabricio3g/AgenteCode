<svelte:options runes={true} />

<!--
  One integrated terminal: xterm.js over a node-pty shell in main. Kept
  mounted while its tab is hidden so scrollback survives switching tabs;
  it re-fits whenever it becomes visible or its box changes size.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { accessibilityStore } from '$lib/stores/accessibility.svelte';
  import { codeFontFamily, codeFontSize, cssToken } from '$lib/utils/type-tokens';
  import { codeWorkspace } from '../workspace.svelte';

  let { id, active, focused = false }: { id: string; active: boolean; focused?: boolean } = $props();

  let host = $state<HTMLDivElement>();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;

  function theme() {
    const dark = themeStore.current === 'dark';
    return {
      background: cssToken('--background', dark ? '#111' : '#fff'),
      foreground: cssToken('--foreground', dark ? '#eee' : '#111'),
      cursor: cssToken('--foreground', dark ? '#eee' : '#111'),
      selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)'
    };
  }

  function refit() {
    if (!term || !fit || !host || !host.offsetParent) return;
    try {
      fit.fit();
      codeWorkspace.resizeTerminal(id, term.cols, term.rows);
    } catch {
      // Not measurable yet (hidden); the next resize fits it.
    }
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: codeFontFamily(),
      fontSize: codeFontSize(),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme()
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host!);
    const input = term.onData((data) => codeWorkspace.writeTerminal(id, data));
    const detach = codeWorkspace.attachTerminal(id, (data) => term?.write(data));
    const observer = new ResizeObserver(() => refit());
    observer.observe(host!);
    requestAnimationFrame(() => {
      refit();
      if (focused) term?.focus();
    });
    return () => {
      observer.disconnect();
      input.dispose();
      detach();
      term?.dispose();
      term = null;
    };
  });

  $effect(() => {
    void themeStore.current;
    void appearanceStore.prefs.theme;
    void appearanceStore.prefs.accent;
    if (term) term.options.theme = theme();
  });

  // Text size and reading font reach the canvas through the tokens; a new cell
  // size changes cols/rows, so the fit addon runs again.
  $effect(() => {
    void accessibilityStore.prefs.textScale;
    void accessibilityStore.prefs.font;
    if (!term) return;
    term.options.fontFamily = codeFontFamily();
    term.options.fontSize = codeFontSize();
    requestAnimationFrame(() => refit());
  });

  $effect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      refit();
    });
  });
  $effect(() => { if (focused && active) requestAnimationFrame(() => term?.focus()); });
</script>

<div class="terminal-host h-full w-full" class:hidden={!active} bind:this={host}></div>

<style>
  .terminal-host {
    /* Right and bottom had none: xterm's last row and its scrollbar landed on
       the dock's rounded corner. */
    padding: 6px 8px 6px 10px;
  }
  .terminal-host :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
