<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { i18nReady } from '$lib/i18n';

  let startupBypassed = $state(false);
  let activeWorkSyncInterval: ReturnType<typeof setInterval> | null = null;
  let startupHintIndex = $state(0);
  let startupHintInterval: ReturnType<typeof setInterval> | null = null;
  const startupHints = [
    'Thinking',
    'Warming up model',
    'Finding files',
    'Loading context',
    'Preparing workspace'
  ];

  onMount(async () => {
    await i18nReady;

    const bypassTimer = window.setTimeout(() => {
      startupBypassed = true;
      if (!appStore.chats.length) {
        appStore.createChat();
      }
    }, 4500);

    startupHintInterval = setInterval(() => {
      startupHintIndex = (startupHintIndex + 1) % startupHints.length;
    }, 1400);

    themeStore.set(themeStore.current);
    deepResearchStore.init();
    // Preload TTS engine in background
    if (!startupBypassed) {
      void ttsStore.preloadEngine();
    }
    activeWorkSyncInterval = setInterval(() => {
      void appStore.syncWindowActiveWork();
    }, 900);
    void appStore.syncWindowActiveWork();
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
    font-size: clamp(1.8rem, 4.4vw, 3.5rem);
    font-weight: 700;
    line-height: 1.1;
    color: var(--text-secondary);
    letter-spacing: -0.02em;
    text-align: center;
  }

  .text-shimmer {
    background: linear-gradient(90deg, var(--text-muted) 10%, var(--text) 50%, var(--text-muted) 90%);
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: startupShimmer 1.9s linear infinite;
  }

  @keyframes startupDotsDrift {
    from { background-position: 0 0; }
    to { background-position: 0 -20px; }
  }

  @keyframes startupShimmer {
    from { background-position: 200% 0; }
    to { background-position: -20% 0; }
  }
</style>
