<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import Titlebar from '$lib/components/layout/Titlebar.svelte';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import Composer from '$lib/components/chat/Composer.svelte';
  import ArtifactStudioModal from '$lib/components/agent/ArtifactStudioModal.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import SystemPromptModal from '$lib/components/settings/SystemPromptModal.svelte';
  import LocalModelLoadModal from '$lib/components/settings/LocalModelLoadModal.svelte';
  import ModelHubModal from '$lib/components/settings/ModelHubModal.svelte';
  import ArtifactSettingsModal from '$lib/components/settings/ArtifactSettingsModal.svelte';
  import LegacyWorkspace from '$lib/components/legacy/LegacyWorkspace.svelte';
  import Toaster from '$lib/components/layout/Toaster.svelte';
  import ConfirmDialog from '$lib/components/layout/ConfirmDialog.svelte';
  import LLMDrawer from '$lib/components/layout/LLMDrawer.svelte';
  import ChatSearchModal from '$lib/components/layout/ChatSearchModal.svelte';
  import SearchSidebar from '$lib/components/search/SearchSidebar.svelte';
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Plus, Boxes, Settings } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { capabilitiesStore } from '$lib/stores/capabilities.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isTauri } from '$lib/services/tauri';
  import { legacyFlagToModelHubSection, resolveModelHubSection } from '$lib/utils/model-hub-routing';

  let showShortcutsHelp = $state(false);
  const newSessionLabel = $derived(
    appStore.activeSpace === 'work' ? 'New Work' : 'New chat'
  );


  function openModelHub(section: string = 'models') {
    appStore.modelManagerOpenSection = resolveModelHubSection(section);
    appStore.modelManagerOpen = true;
  }

  function handleKeydown(event: KeyboardEvent) {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const ctrl = isMac ? event.metaKey : event.ctrlKey;
    const target = event.target as HTMLElement;
    const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    if (ctrl && event.key === 'k' && !event.shiftKey) {
      event.preventDefault();
      appStore.createChat(appStore.activeSpace);
      return;
    }
    if (ctrl && event.key === 'k' && event.shiftKey) {
      event.preventDefault(); appStore.chatSearchOpen = !appStore.chatSearchOpen; return;
    }
    if (ctrl && event.key === ',') {
      event.preventDefault(); openModelHub('general'); return;
    }
    if (ctrl && event.key === 'b') {
      event.preventDefault(); appStore.sidebarOpen = !appStore.sidebarOpen; return;
    }
    // Ctrl+` toggles the artifact studio
    if (ctrl && event.key === '`') {
      event.preventDefault();
      if (appStore.currentArtifact) appStore.artifactStudioOpen = !appStore.artifactStudioOpen;
      return;
    }
    if (ctrl && event.key === 'e' && !inInput) {
      event.preventDefault();
      const chat = appStore.currentChat;
      if (!chat?.messages?.length) return;
      const dateStr = new Date().toISOString().slice(0, 10);
      const lines = [`# ${chat.title || 'Chat'}\n\n*Exported ${dateStr}*\n`];
      for (const m of chat.messages) {
        lines.push('---');
        if (m.role === 'user') lines.push(`**You:**\n\n${m.content}`);
        else lines.push(`**Assistant**${m.model ? ` (${m.model})` : ''}:\n\n${m.content}`);
      }
      const filename = `${(chat.title || 'chat').replace(/[^a-z0-9]+/gi, '_')}_${dateStr}.md`;
      const blob = new Blob([lines.join('\n\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.setAttribute('download', filename);
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      return;
    }
    if (event.key === '?' && ctrl) {
      event.preventDefault(); showShortcutsHelp = !showShortcutsHelp; return;
    }
    if (event.key === 'Escape' && showShortcutsHelp) showShortcutsHelp = false;
  }

  function drawerSlotTransition(node: Element) {
    const width = node.getBoundingClientRect().width;
    return {
      duration: 260,
      easing: cubicOut,
      css: (t: number, u: number) => `
        width: ${Math.max(0.001, width * t)}px;
        min-width: ${Math.max(0.001, width * t)}px;
        opacity: ${t};
        transform: translateX(${u * 14}px) scale(${0.985 + t * 0.015});
      `
    };
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    if (isTauri()) {
      void hardwareStore.refresh();
      void capabilitiesStore.refresh();
    }
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  $effect(() => {
    if (!appStore.settingsOpen) return;
    appStore.settingsOpen = false;
    openModelHub(legacyFlagToModelHubSection('settingsOpen'));
  });

  $effect(() => {
    if (!appStore.runtimeManagerOpen) return;
    appStore.runtimeManagerOpen = false;
    openModelHub(legacyFlagToModelHubSection('runtimeManagerOpen'));
  });
</script>

<div class="flex h-full overflow-hidden bg-background text-foreground">
  {#if appStore.workspaceMode === 'legacy'}
    <!-- No overflow-hidden on this column: titlebar fade hangs below h-9. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Titlebar />
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <LegacyWorkspace />
      </div>
    </div>
  {:else}
    <!-- Full-height sidebar (Flaxeo pattern): sidebar | titlebar+main -->
    <div
      class="sidebar-outer relative flex shrink-0 flex-col overflow-hidden bg-sidebar"
      class:expanded={appStore.sidebarOpen}
    >
      <div class="sidebar-view-full absolute inset-0 flex flex-col">
        <Sidebar />
      </div>

      <div class="sidebar-view-collapsed absolute inset-0 flex flex-col items-center gap-0.5 px-2 pt-3">
        <Tooltip label={newSessionLabel}>
          <button
            class="aui-icon-button size-8"
            onclick={() => {
              appStore.createChat(appStore.activeSpace);
            }}
            aria-label={newSessionLabel}
          >
            <Plus class="size-4" />
          </button>
        </Tooltip>

        <div class="flex-1"></div>

        <Tooltip label="Models">
          <button
            class="aui-icon-button size-8"
            onclick={() => openModelHub('models')}
            aria-label="Models"
          >
            <Boxes class="size-4" />
          </button>
        </Tooltip>
        <Tooltip label="Settings">
          <button
            class="aui-icon-button size-8 mb-1"
            onclick={() => openModelHub('general')}
            aria-label="Settings"
          >
            <Settings class="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>

    <!-- No overflow-hidden on this column: titlebar fade hangs below h-9. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <Titlebar />

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <div class="chat-panel relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div class="chat-content-layer relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <MessageList />
            <Composer />
          </div>
        </div>

        {#if appStore.activityDrawerOpen}
          <div class="activity-drawer-slot" transition:drawerSlotTransition>
            <ActivityDrawer />
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if appStore.workspaceMode === 'modern'}
    {#if appStore.promptConfigOpen}
      <SystemPromptModal />
    {/if}
    <LocalModelLoadModal />

    {#if appStore.modelManagerOpen}
      <ModelHubModal />
    {/if}

    {#if appStore.artifactSettingsOpen}
      <ArtifactSettingsModal />
    {/if}
  {/if}
</div>

<Toaster />
<ConfirmDialog />
<LLMDrawer />

{#if appStore.artifactStudioOpen && appStore.currentArtifact}
  <ArtifactStudioModal />
{/if}

{#if appStore.chatSearchOpen}
  <ChatSearchModal />
{/if}

{#if appStore.searchSidebarOpen}
  <SearchSidebar />
{/if}

{#if appStore.onboardingOpen}
  <OnboardingWizard />
{/if}

{#if showShortcutsHelp}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="aui-dialog-backdrop fixed inset-0 z-[300] flex items-center justify-center px-4" onclick={() => (showShortcutsHelp = false)}>
    <div
      class="w-full max-w-sm rounded-lg border border-border bg-popover p-6 shadow-lg"
      role="dialog" aria-modal="true" tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') showShortcutsHelp = false; }}
    >
      <h2 class="mb-4 text-base font-semibold text-foreground">Keyboard shortcuts</h2>
      <dl class="space-y-3 text-sm">
        {#each [
          ['Ctrl+K', 'New chat'],
          ['Ctrl+Shift+K', 'Search chats'],
          ['Ctrl+,', 'Open Settings'],
          ['Ctrl+B', 'Show or hide sidebar'],
          ['Ctrl+`', 'Toggle artifact studio'],
          ['Ctrl+E', 'Export chat'],
          ['Ctrl+?', 'This help'],
          ['Escape', 'Close dialog / Stop stream'],
        ] as [key, label]}
          <div class="flex items-center justify-between gap-4">
            <span class="text-muted-foreground">{label}</span>
            <kbd class="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{key}</kbd>
          </div>
        {/each}
      </dl>
      <p class="mt-4 text-xs text-muted-foreground">On macOS, Ctrl = ⌘ Cmd</p>
    </div>
  </div>
{/if}

<style>
  .sidebar-outer {
    width: 3.5rem; /* w-14 */
    transition: width 200ms var(--motion-ease);
    will-change: width;
  }
  .sidebar-outer.expanded {
    width: 13rem; /* w-52 */
  }

  .sidebar-view-full {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    overflow: hidden;
    transition: opacity 150ms ease, visibility 0s linear 150ms;
  }
  .sidebar-outer.expanded .sidebar-view-full {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition-delay: 40ms, 0s;
  }

  .sidebar-view-collapsed {
    opacity: 1;
    visibility: visible;
    transition: opacity 120ms ease, visibility 0s linear;
  }

  .sidebar-outer.expanded .sidebar-view-collapsed {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition-delay: 0s, 120ms;
  }

  .chat-panel {
    background: var(--background);
    border-color: var(--border);
    border-style: solid;
    border-width: 1px 0 0 1px;
    border-radius: var(--radius-2xl) 0 0 0;
  }

  .activity-drawer-slot {
    display: flex;
    height: 100%;
    flex: 0 0 auto;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background: var(--background);
    transform-origin: right center;
    will-change: width, min-width, opacity, transform;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-outer { transition: none; will-change: auto; }
  }
</style>
