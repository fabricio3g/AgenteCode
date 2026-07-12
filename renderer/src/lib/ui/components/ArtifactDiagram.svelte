<svelte:options runes={true} />

<script lang="ts">
  import type { DiagramArtifactPayload } from '$lib/types/chat';

  interface Props {
    payload: DiagramArtifactPayload;
  }

  let { payload }: Props = $props();

  let diagramEl = $state<HTMLDivElement | undefined>(undefined);
  let error = $state('');
  let lastKey = $state('');
  let mermaidModule: typeof import('mermaid') | null = null;

  function stableHash(value: string) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  $effect(() => {
    if (!diagramEl) return;
    const source = String(payload.source || '').trim();
    const key = `${payload.title}|${payload.diagramType || ''}|${source}`;
    if (!source || key === lastKey) return;
    lastKey = key;
    const renderId = `artifact-diagram-${stableHash(key)}`;
    let cancelled = false;

    error = '';
    (async () => {
      mermaidModule ||= await import('mermaid');
      const mermaid = mermaidModule.default;
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        deterministicIds: true,
        deterministicIDSeed: stableHash(key),
        theme: 'base',
        themeVariables: {
          background: 'transparent',
          primaryColor: '#eef0ff',
          primaryTextColor: '#1f2437',
          primaryBorderColor: '#0d0d0d',
          lineColor: '#0d0d0d',
          secondaryColor: '#f5f6ff',
          tertiaryColor: '#ffffff'
        }
      });
      const { svg } = await mermaid.render(renderId, source);
      return svg;
    })()
      .then((svg) => {
        if (!svg) return;
        if (cancelled || !diagramEl) return;
        diagramEl.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (cancelled || !diagramEl) return;
        error = err instanceof Error ? err.message : String(err || 'Could not render diagram');
        diagramEl.textContent = '';
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<section class="artifact-diagram" aria-label={payload.title || 'Diagram'}>
  {#if payload.title}
    <h3>{payload.title}</h3>
  {/if}
  <div bind:this={diagramEl} class="diagram-output"></div>
  {#if error}
    <pre class="diagram-error">{payload.source}</pre>
    <p class="diagram-error-text">{error}</p>
  {/if}
</section>

<style>
  .artifact-diagram {
    width: min(100%, 42rem);
    margin-top: 0.65rem;
    color: var(--text);
  }

  .artifact-diagram h3 {
    margin: 0 0 0.45rem;
    font-size: 0.95rem;
    font-weight: 650;
  }

  .diagram-output {
    overflow-x: auto;
  }

  .diagram-output :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .diagram-error {
    margin: 0.5rem 0 0;
    overflow-x: auto;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    white-space: pre-wrap;
  }

  .diagram-error-text {
    margin: 0.35rem 0 0;
    color: var(--error);
    font-size: 0.75rem;
  }
</style>
