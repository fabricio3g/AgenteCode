<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { i18nReady } from '$lib/i18n';
  import { APP_TAGLINE } from '$lib/app-meta';

  let startupBypassed = $state(false);
  let activeWorkSyncInterval: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await i18nReady;

    const bypassTimer = window.setTimeout(() => {
      startupBypassed = true;
      if (!appStore.chats.length) {
        appStore.createChat();
      }
    }, 2500);

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
  });
</script>

{#if appStore.ready || startupBypassed}
  <AppShell />
{/if}

{#if !appStore.ready && !startupBypassed}
  <div class="flex h-full items-center justify-center">
    <div class="surface-panel rounded-[1.7rem] px-6 py-5 text-sm text-fg-ter">
      {appStore.error ? `Recovering from startup issue: ${appStore.error}` : APP_TAGLINE}
    </div>
  </div>
{/if}
