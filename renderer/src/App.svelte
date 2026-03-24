<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';

  let startupBypassed = $state(false);

  onMount(() => {
    const bypassTimer = window.setTimeout(() => {
      startupBypassed = true;
      if (!appStore.chats.length) {
        appStore.createChat();
      }
    }, 2500);

    themeStore.set(themeStore.current);
    deepResearchStore.init();
    void appStore.init().catch((error) => {
      console.error('[App] init failed', error);
      appStore.error = String((error as Error)?.message || error || 'Failed to initialize');
      appStore.ready = true;
    }).finally(() => {
      window.clearTimeout(bypassTimer);
    });
  });
</script>

{#if appStore.ready || startupBypassed}
  <AppShell />
{/if}

{#if !appStore.ready && !startupBypassed}
  <div class="flex h-full items-center justify-center">
    <div class="surface-panel rounded-[1.7rem] px-6 py-5 text-sm text-neutral-500 dark:text-neutral-300">
      {appStore.error ? `Recovering from startup issue: ${appStore.error}` : 'Loading TalamoLM...'}
    </div>
  </div>
{/if}
