<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import WindowControls from '$lib/components/layout/WindowControls.svelte';
  import { initMotion } from '$lib/utils/motion.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { i18nReady } from '$lib/i18n';
  import { installReferenceIconFallback } from '$lib/utils/markdown-references';
  import { installCodeCopyDelegate } from '$lib/utils/code-copy';
  import { notifyDesktopReady } from '$lib/services/desktop-startup';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { copy } from '$lib/copy';
  import { startReminders } from '$lib/services/reminder-notifications';
  import { startBrowserChat } from '$lib/services/browser-chat';
  import { startComputerUseEvents } from '$lib/features/computer/computer.svelte';
  // The landing page's tile field, shared verbatim: the startup screen and the
  // site's hero render the same mosaic from the same file.

  let startupBypassed = $state(false);
  let activeWorkSyncInterval: ReturnType<typeof setInterval> | null = null;
  let startupHintIndex = $state(0);
  let startupHintInterval: ReturnType<typeof setInterval> | null = null;
  let teardownReferences: (() => void) | null = null;
  let teardownCodeCopy: (() => void) | null = null;
  let teardownBrowserChat: (() => void) | null = null;
  let teardownComputer: (() => void) | null = null;
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
    step('reference-icons', () => { teardownReferences = installReferenceIconFallback(); });
    step('reminders', startReminders);
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
      const chatId = new URLSearchParams(window.location.search).get('conversation');
      if (chatId && appStore.chats.some((chat) => chat.id === chatId)) codeStore.openConversation(chatId);
      // The extension's chat panel is answered once the chats are loaded.
      step('browser-chat', () => void startBrowserChat().then((off) => { teardownBrowserChat = off; }));
      step('computer', () => void startComputerUseEvents().then((off) => { teardownComputer = off; }));
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
    teardownReferences?.();
    teardownCodeCopy?.();
    teardownCodeCopy = null;
    teardownBrowserChat?.();
    teardownComputer?.();
  });
</script>

{#if appStore.ready || startupBypassed}
  <AppShell />
{/if}

{#if !appStore.ready && !startupBypassed}
  <!-- Quiet on purpose: the app's own background, its mark, one status line.
       The top strip stays draggable so the window can move while it loads. -->
  <div class="startup-loading-screen">
    <div class="startup-drag titlebar-drag">
      <WindowControls />
    </div>
    <img class="startup-mark" src="./app-icon.svg" alt="" aria-hidden="true" />
    <div class="startup-loading-text" class:text-shimmer={!appStore.error} role="status">
      {appStore.error ? `Recovering from startup issue: ${appStore.error}` : startupHints[startupHintIndex]}
    </div>
  </div>
{/if}

<style>
  .startup-loading-screen {
    position: relative;
    display: flex;
    height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.875rem;
    background: var(--background);
  }

  .startup-drag {
    position: absolute;
    inset: 0 0 auto;
    display: flex;
    height: 2.25rem;
    align-items: center;
    justify-content: flex-end;
    padding-inline-end: 0.75rem;
  }

  .startup-mark {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--float-row-radius);
    animation: startupIn 400ms var(--motion-ease-out) both;
  }

  .startup-loading-text {
    max-width: min(32rem, calc(100vw - 2rem));
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: center;
    animation: startupIn 400ms 80ms var(--motion-ease-out) both;
  }

  .text-shimmer {
    background: linear-gradient(90deg, var(--muted-foreground) 25%, var(--foreground) 45%, var(--muted-foreground) 65%);
    background-size: 300% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: startupIn 400ms 80ms var(--motion-ease-out) both, startupShimmer 2.8s ease-in-out infinite;
  }

  @keyframes startupShimmer {
    from { background-position: 200% 0; }
    to { background-position: -20% 0; }
  }

  @keyframes startupIn {
    from { opacity: 0; transform: translateY(4px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .startup-mark, .startup-loading-text { animation: none; }
    .text-shimmer { background: none; -webkit-text-fill-color: var(--muted-foreground); }
  }
</style>
