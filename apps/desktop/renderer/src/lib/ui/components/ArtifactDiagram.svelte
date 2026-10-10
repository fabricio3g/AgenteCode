<svelte:options runes={true} />

<script lang="ts">
  import type { DiagramArtifactPayload } from '$lib/types/chat';
  import { themeStore } from '$lib/stores/theme.svelte';

  interface Props {
    payload: DiagramArtifactPayload;
  }

  let { payload }: Props = $props();

  let diagramEl = $state<HTMLDivElement | undefined>(undefined);
  let error = $state('');
  let loading = $state(false);
  /*
   * Deliberately a plain `let`, not `$state`.
   *
   * As `$state` this latch was both read and written inside the effect below, so
   * assigning it self-invalidated the effect. Svelte then ran the teardown —
   * setting `cancelled = true` — before the dynamic `import('mermaid')` had
   * resolved, and every render bailed at the cancellation check. Neither the
   * diagram nor the error branch ever appeared: diagrams were reliably blank with
   * no way to tell why. It is a render-dedupe latch, not reactive state.
   */
  let lastKey = '';
  let mermaidModule: typeof import('mermaid') | null = null;

  function stableHash(value: string) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Mermaid needs concrete colour values — it bakes them into the SVG it returns,
   * so `var(--token)` cannot be handed over. These are read off the live computed
   * style instead, which keeps diagrams legible in both themes. They used to be
   * six hardcoded light-mode hexes, unreadable on the dark artifact surface.
   */
  function themeVariables(root: HTMLElement) {
    // Mermaid's color math only understands hex/rgb/hsl; tokens are often
    // oklch() or color-mix(), which it silently turns into dark grays. Let the
    // browser resolve each token to rgb() first.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    root.appendChild(probe);
    const read = (name: string) => {
      probe.style.color = '';
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color || 'rgb(0, 0, 0)';
    };
    const surface = read('--card');
    const node = read('--muted');
    const ink = read('--foreground');
    const line = read('--muted-foreground');
    const border = read('--border');
    probe.remove();
    return {
      background: 'transparent',
      fontFamily: getComputedStyle(root).fontFamily,
      fontSize: getComputedStyle(root).fontSize,
      primaryColor: node,
      primaryTextColor: ink,
      primaryBorderColor: border,
      secondaryColor: node,
      tertiaryColor: surface,
      mainBkg: node,
      nodeBorder: border,
      clusterBkg: surface,
      clusterBorder: border,
      lineColor: line,
      textColor: ink,
      edgeLabelBackground: surface,
      labelBackground: surface,
      titleColor: ink
    };
  }

  $effect(() => {
    if (!diagramEl) return;
    const source = String(payload.source || '').trim();
    // Re-render on theme change: the colours are baked into the returned SVG.
    const key = `${payload.title}|${payload.diagramType || ''}|${themeStore.current}|${source}`;
    if (!source || key === lastKey) return;
    lastKey = key;
    const renderId = `artifact-diagram-${stableHash(key)}`;
    const target = diagramEl;
    let cancelled = false;

    error = '';
    loading = true;
    (async () => {
      mermaidModule ||= await import('mermaid');
      const mermaid = mermaidModule.default;
      if (cancelled) return null;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        deterministicIds: true,
        deterministicIDSeed: stableHash(key),
        theme: 'base',
        themeVariables: themeVariables(target)
      });
      const { svg } = await mermaid.render(renderId, source);
      return svg;
    })()
      .then((svg) => {
        if (cancelled || !svg) return;
        target.innerHTML = svg;
      })
      .catch((err: unknown) => {
        /*
         * No `cancelled` guard. It used to be here, and because the effect
         * cancelled itself on every run it swallowed genuine mermaid syntax
         * errors along with the spurious ones — a malformed diagram showed
         * nothing at all rather than the source and the parser message.
         */
        error = err instanceof Error ? err.message : String(err || 'Could not render diagram');
        target.textContent = '';
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<section class="viz-surface artifact-diagram" aria-label={payload.title || 'Diagram'}>
  {#if payload.title}
    <header class="viz-header"><h3 class="viz-title">{payload.title}</h3></header>
  {/if}
  <div bind:this={diagramEl} class="diagram-output"></div>
  {#if loading}
    <!-- Mermaid is a large dynamic import; without this the block is empty while it loads. -->
    <p class="diagram-loading">Rendering diagram…</p>
  {/if}
  {#if error}
    <pre class="diagram-error">{payload.source}</pre>
    <p class="diagram-error-text">{error}</p>
  {/if}
</section>

<style>
  .diagram-output {
    overflow-x: auto;
  }

  .diagram-output :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .diagram-loading {
    margin: 0.35rem 0 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .diagram-error {
    margin: 0.5rem 0 0;
    overflow-x: auto;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    white-space: pre-wrap;
  }

  .diagram-error-text {
    margin: 0.35rem 0 0;
    color: var(--error);
    font-size: var(--text-xs);
  }
</style>
