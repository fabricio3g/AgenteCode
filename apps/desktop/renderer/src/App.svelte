<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import { initMotion } from '$lib/utils/motion.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { i18nReady } from '$lib/i18n';
  import { installCodeCopyDelegate } from '$lib/utils/code-copy';
  import { copy } from '$lib/copy';

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
    // Preload TTS engine in background
    if (!startupBypassed) {
      step('tts-preload', () => void ttsStore.preloadEngine());
    }
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
    <div class="startup-dots-layer" aria-hidden="true"></div>
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
  }

  .startup-dots-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      radial-gradient(circle, color-mix(in srgb, var(--text-muted) 55%, transparent) 0 1.2px, transparent 2px),
      radial-gradient(circle, color-mix(in srgb, var(--text-muted) 32%, transparent) 0 1px, transparent 1.8px);
    background-size: 18px 18px, 26px 26px;
    background-position: 0 0, 8px 10px;
    mask-image: radial-gradient(circle at center, rgba(0,0,0,0.01) 0%, rgba(0,0,0,0.12) 24%, rgba(0,0,0,0.58) 62%, rgba(0,0,0,0.96) 100%);
    -webkit-mask-image: radial-gradient(circle at center, rgba(0,0,0,0.01) 0%, rgba(0,0,0,0.12) 24%, rgba(0,0,0,0.58) 62%, rgba(0,0,0,0.96) 100%);
    animation: startupDotsDrift 9s linear infinite;
    opacity: 0.62;
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

  @keyframes startupDotsDrift {
    from { background-position: 0 0; }
    to { background-position: 0 -20px; }
  }

  @keyframes startupShimmer {
    from { background-position: 200% 0; }
    to { background-position: -20% 0; }
  }

  @media (prefers-reduced-motion: reduce), (max-width: 768px), (pointer: coarse) {
    .startup-dots-layer { animation: none; }
    .text-shimmer { animation: none; background: none; -webkit-text-fill-color: var(--text-muted); }
  }
</style>
