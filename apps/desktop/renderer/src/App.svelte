<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import AppShell from '$lib/components/layout/AppShell.svelte';
  import StartupMark from '$lib/components/layout/StartupMark.svelte';
  import WindowControls from '$lib/components/layout/WindowControls.svelte';
  import { initMotion } from '$lib/utils/motion.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import { i18nReady } from '$lib/i18n';
  import { installReferenceIconFallback } from '$lib/utils/markdown-references';
  import { installCodeCopyDelegate } from '$lib/utils/code-copy';
  import { notifyDesktopReady } from '$lib/services/desktop-startup';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { startReminders } from '$lib/services/reminder-notifications';
  import { startBrowserChat } from '$lib/services/browser-chat';
  import { startComputerUseEvents } from '$lib/features/computer/computer.svelte';
  import { startSessionGoalEvents } from '$lib/services/session-goals';

  const STARTUP_MIN_MS = 1500;
  const startupStartedAt = Date.now();
  let startupReady = $state(false);
  let startupBypassed = $state(false);
  let activeWorkSyncInterval: ReturnType<typeof setInterval> | null = null;
  let teardownReferences: (() => void) | null = null;
  let teardownCodeCopy: (() => void) | null = null;
  let teardownBrowserChat: (() => void) | null = null;
  let teardownComputer: (() => void) | null = null;
  let teardownGoals: (() => void) | null = null;

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

    step('theme', () => appearanceStore.sync());
    step('deep-research', () => deepResearchStore.init());
    activeWorkSyncInterval = setInterval(() => {
      step('work-sync', () => void appStore.syncWindowActiveWork());
    }, 900);
    step('work-sync', () => void appStore.syncWindowActiveWork());
    void appStore.init().catch((error) => {
      console.error('[App] init failed', error);
      appStore.error = String((error as Error)?.message || error || 'Failed to initialize');
      appStore.ready = true;
    }).finally(async () => {
      // A fast dev launch can finish before the first paint. Keep the mark on
      // screen long enough to read as the loading state, not a flash.
      const remaining = Math.max(0, STARTUP_MIN_MS - (Date.now() - startupStartedAt));
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      startupReady = true;
      window.clearTimeout(bypassTimer);
      const chatId = new URLSearchParams(window.location.search).get('conversation');
      if (chatId && appStore.chats.some((chat) => chat.id === chatId)) codeStore.openConversation(chatId);
      // The extension's chat panel is answered once the chats are loaded.
      step('browser-chat', () => void startBrowserChat().then((off) => { teardownBrowserChat = off; }));
      step('computer', () => void startComputerUseEvents().then((off) => { teardownComputer = off; }));
      step('goals', () => void startSessionGoalEvents().then((off) => { teardownGoals = off; }));
      void tick().then(notifyDesktopReady).catch((error) => console.error('[startup]', error));
    });
  });

  onDestroy(() => {
    if (activeWorkSyncInterval) {
      clearInterval(activeWorkSyncInterval);
      activeWorkSyncInterval = null;
    }
    teardownReferences?.();
    teardownCodeCopy?.();
    teardownCodeCopy = null;
    teardownBrowserChat?.();
    teardownComputer?.();
  teardownGoals?.();
  });
</script>

{#if startupReady || startupBypassed}
  <AppShell />
{/if}

{#if !startupReady && !startupBypassed}
  <!-- Quiet on purpose: the app's own background, its mark. The top strip
       stays draggable so the window can move while it loads. -->
  <div class="startup-loading-screen">
    <div class="startup-drag titlebar-drag">
      <WindowControls />
    </div>
    <StartupMark />
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
    background: #000000;
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
</style>
