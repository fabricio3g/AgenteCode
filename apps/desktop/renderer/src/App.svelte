<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import { initMotion } from '$lib/utils/motion.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { i18nReady } from '$lib/i18n';
  import { installCodeCopyDelegate } from '$lib/utils/code-copy';
  import { notifyDesktopReady } from '$lib/services/desktop-startup';
  import { copy } from '$lib/copy';
  // The landing page's tile field, shared verbatim: the startup screen and the
  // site's hero render the same mosaic from the same file.
  import { mountTiles } from '$site/js/tiles.js';

  let startupBypassed = $state(false);
  let activeWorkSyncInterval: ReturnType<typeof setInterval> | null = null;
  let startupHintIndex = $state(0);
  let startupHintInterval: ReturnType<typeof setInterval> | null = null;
  let teardownCodeCopy: (() => void) | null = null;
  // Startup is a progress indicator, not a personality. One verb, from the
  // canonical status vocabulary, plus concrete steps.
  const startupHints = [
    copy.status.loading,
    'Warming up model',
    'Loading context',
    'Preparing workspace'
  ];

  /**
   * Mount the tile field on the startup canvas, and tear it down with it.
   *
   * Svelte's action destroy runs when the loading screen unmounts, so the rAF
   * loop and the observers never outlive the screen they were drawn for.
   */
  function tileField(node: HTMLCanvasElement) {
    const tiles = mountTiles(node, { focus: [0.5, 0.72], spread: 1.5, dim: 0.8 });
    return {
      destroy: () => tiles.destroy()
    };
  }

  /**
   * Run one startup step in isolation.
   *
   * Startup used to be a straight line of unguarded calls, so a single failing
   * step — most of them reach into the Electron bridge — aborted every step
   * after it. The window still rendered via the bypass timer, which left an app
   * whose controls were bound to a store that had never been initialised: every
   * click updated state that nothing was listening to.
   */
  function step(name: string, run: () => void) {
    try {
      run();
    } catch (error) {
      console.error(`[App] startup step "${name}" failed`, error);
    }
  }

  onMount(async () => {
    step('motion', initMotion);
    step('code-copy', () => {
      teardownCodeCopy = installCodeCopyDelegate();
    });
    try {
      await i18nReady;
    } catch (error) {
      console.error('[App] i18n failed to load', error);
    }

    const bypassTimer = window.setTimeout(() => {
      startupBypassed = true;
      if (!appStore.chats.length) {
        appStore.createChat();
      }
    }, 4500);

    startupHintInterval = setInterval(() => {
      startupHintIndex = (startupHintIndex + 1) % startupHints.length;
    }, 1400);

    step('theme', () => themeStore.set(themeStore.current));
    step('deep-research', () => deepResearchStore.init());
    activeWorkSyncInterval = setInterval(() => {
      step('work-sync', () => void appStore.syncWindowActiveWork());
    }, 900);
    step('work-sync', () => void appStore.syncWindowActiveWork());
    void appStore.init().catch((error) => {
      console.error('[App] init failed', error);
      appStore.error = String((error as Error)?.message || error || 'Failed to initialize');
      appStore.ready = true;
    }).finally(() => {
      window.clearTimeout(bypassTimer);
      void tick().then(notifyDesktopReady).catch((error) => console.error('[startup]', error));
    });
  });

  onDestroy(() => {
    if (activeWorkSyncInterval) {
      clearInterval(activeWorkSyncInterval);
      activeWorkSyncInterval = null;
    }
    if (startupHintInterval) {
      clearInterval(startupHintInterval);
      startupHintInterval = null;
    }
    teardownCodeCopy?.();
    teardownCodeCopy = null;
  });
</script>

{#if appStore.ready || startupBypassed}
  <AppShell />
{/if}

{#if !appStore.ready && !startupBypassed}
  <div class="startup-loading-screen">
    <canvas class="startup-tiles" use:tileField aria-hidden="true"></canvas>
    <div class="startup-loading-text text-shimmer">
      {appStore.error ? `Recovering from startup issue: ${appStore.error}` : startupHints[startupHintIndex]}
    </div>
  </div>
{/if}

<style>
  .startup-loading-screen {
    position: relative;
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    /* The glow under the mosaic; also the no-canvas look. */
    background: radial-gradient(70% 55% at 50% 96%, var(--glow), transparent 70%);
  }

  /* The landing page's tile field, full window. The mask quiets the mosaic
     behind the status line so the copy always wins, exactly like the hero's
     `.tiles` mask does for the headline. */
  .startup-tiles {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: 0;
    /* The field fades in with its own first second of drift, so the screen
       never flashes an empty canvas before the mosaic arrives. */
    animation: startupTilesIn 1.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    mask-image: radial-gradient(ellipse 38% 30% at 50% 50%, rgb(0 0 0 / 0.15), #000 100%);
    -webkit-mask-image: radial-gradient(ellipse 38% 30% at 50% 50%, rgb(0 0 0 / 0.15), #000 100%);
  }

  .startup-loading-text {
    position: relative;
    z-index: 1;
    font-size: clamp(1.4rem, 3.2vw, 2.25rem);
    font-weight: 600;
    line-height: 1.15;
    color: var(--muted-foreground);
    letter-spacing: -0.02em;
    text-align: center;
  }

  .text-shimmer {
    background: linear-gradient(90deg, var(--muted-foreground) 25%, var(--foreground) 45%, var(--muted-foreground) 65%);
    background-size: 300% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: startupShimmer 2.8s ease-in-out infinite;
  }

  @keyframes startupShimmer {
    from { background-position: 200% 0; }
    to { background-position: -20% 0; }
  }

  @keyframes startupTilesIn {
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce), (max-width: 768px), (pointer: coarse) {
    /* The field paints one still frame under reduced motion; the fade and the
       text shimmer are the only things left to switch off. */
    .startup-tiles { animation: none; opacity: 1; }
    .text-shimmer { animation: none; background: none; -webkit-text-fill-color: var(--text-muted); }
  }
</style>
