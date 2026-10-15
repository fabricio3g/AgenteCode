<svelte:options runes={true} />

<!--
  An HTML card or an interactive widget, drawn in the app's own style.

  Static cards (no script) keep scripts off and grant `allow-same-origin` only
  so this component can measure them. Widgets (with a script) get the opposite:
  `allow-scripts` with an opaque origin and a no-network CSP (see widget-kit),
  and report their own height by message.
-->

<script lang="ts">
  import type { HtmlCardArtifactPayload } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { buildWidgetDocument, readThemeTokens } from './widget-kit';

  interface Props {
    payload: HtmlCardArtifactPayload;
  }

  let { payload }: Props = $props();

  const MAX_HEIGHT = 720;
  let frame = $state<HTMLIFrameElement>();
  let height = $state(160);
  let error = $state('');
  let tokens = $state(typeof document === 'undefined' ? '' : readThemeTokens());

  const interactive = $derived(!!payload.script?.trim());
  const srcdoc = $derived(buildWidgetDocument({ html: String(payload.html || ''), script: payload.script, tokens }));

  // Follow the app theme: the card re-renders when light/dark flips.
  $effect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const next = readThemeTokens();
      if (next !== tokens) tokens = next;
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  });

  const clampHeight = (value: number) => Math.min(MAX_HEIGHT, Math.max(40, Math.ceil(value)));

  // Static card: measure the same-origin document directly.
  $effect(() => {
    if (!frame || interactive) return;
    let observer: ResizeObserver | null = null;
    // The body, not the document: the document is never shorter than the frame.
    const measure = () => {
      const body = frame?.contentDocument?.body;
      if (body) height = clampHeight(body.getBoundingClientRect().height);
    };
    const onLoad = () => {
      measure();
      observer?.disconnect();
      const root = frame?.contentDocument?.body;
      if (root && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(root);
      }
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame?.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  });

  // Widget: messages from this frame only.
  $effect(() => {
    if (!interactive) return;
    error = '';
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { source?: string; type?: string; height?: number; text?: string; message?: string };
      if (data?.source !== 'flaxeo-widget') return;
      if (data.type === 'height' && typeof data.height === 'number') height = clampHeight(data.height);
      else if (data.type === 'error') error = String(data.message || 'Script error').slice(0, 200);
      else if (data.type === 'ask' && data.text?.trim()) {
        // A suggestion, never a send: the user reviews it in the composer.
        appStore.updateComposer(data.text.trim());
        window.dispatchEvent(new Event('focus-composer'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

<section class="viz-surface html-card" aria-label={payload.title || 'HTML card'}>
  {#if payload.title}
    <header class="viz-header">
      <h3 class="viz-title">{payload.title}</h3>
    </header>
  {/if}
  <div class="html-card-frame-wrap" style:height={`${height}px`}>
    {#if interactive}
      <iframe
        bind:this={frame}
        class="html-card-frame"
        title={payload.title || 'Widget'}
        {srcdoc}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        scrolling={height >= MAX_HEIGHT ? 'auto' : 'no'}
      ></iframe>
    {:else}
      <iframe
        bind:this={frame}
        class="html-card-frame"
        title={payload.title || 'HTML card'}
        {srcdoc}
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
        scrolling={height >= MAX_HEIGHT ? 'auto' : 'no'}
      ></iframe>
    {/if}
  </div>
  {#if error}
    <p class="html-card-error">{error}</p>
  {/if}
</section>

<style>
  .html-card-frame-wrap {
    width: 100%;
    overflow: hidden;
    transition: height var(--motion-normal) var(--motion-ease-out);
  }

  .html-card-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }

  .html-card-error {
    margin: 0.4rem 0 0;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  @media (prefers-reduced-motion: reduce) {
    .html-card-frame-wrap { transition: none; }
  }
</style>
