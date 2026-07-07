<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import Titlebar from '$lib/components/layout/Titlebar.svelte';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import Composer from '$lib/components/chat/Composer.svelte';
  import SandboxModal from '$lib/components/agent/SandboxModal.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import CodeWorkspaceDrawer from '$lib/components/agent/CodeWorkspaceDrawer.svelte';
  import CodeTopbar from '$lib/components/agent/CodeTopbar.svelte';
  import SystemPromptModal from '$lib/components/settings/SystemPromptModal.svelte';
  import LocalModelLoadModal from '$lib/components/settings/LocalModelLoadModal.svelte';
  import ModelHubModal from '$lib/components/settings/ModelHubModal.svelte';
  import LegacyWorkspace from '$lib/components/legacy/LegacyWorkspace.svelte';
  import Toaster from '$lib/components/layout/Toaster.svelte';
  import ConfirmDialog from '$lib/components/layout/ConfirmDialog.svelte';
  import CodeBashApprovalModal from '$lib/components/agent/CodeBashApprovalModal.svelte';
  import { getNextPendingApproval, subscribe } from '$lib/stores/approvals.svelte';
  import type { PendingApproval } from '$lib/stores/approvals.svelte';
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
  let composerHeight = $state(320);
  let pendingApproval = $state<PendingApproval | null>(null);
  let codeDrawerOpen = $state(false);

  $effect(() => {
    const unsub = subscribe(() => {
      pendingApproval = getNextPendingApproval() || null;
    });
    return unsub;
  });

  const hasMessages = $derived((appStore.currentChat?.messages?.length || 0) > 0);

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
      event.preventDefault(); appStore.createChat(); return;
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
    // Ctrl+` toggles sandbox panel
    if (ctrl && event.key === '`') {
      event.preventDefault();
      if (appStore.currentArtifact) appStore.sandboxOpen = !appStore.sandboxOpen;
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

<div class="flex h-full flex-col overflow-hidden">
  <div class="ambient-gradient"></div>

  <Titlebar />

  <div class="flex min-h-0 flex-1 gap-2 p-2">
    {#if appStore.workspaceMode === 'legacy'}
      <LegacyWorkspace />
    {:else}
      <div
        class="sidebar-outer relative flex shrink-0 flex-col overflow-hidden"
        class:expanded={appStore.sidebarOpen}
      >
        <div class="sidebar-view-full absolute inset-0 flex flex-col">
          <Sidebar />
        </div>

        <div class="sidebar-view-collapsed absolute inset-0 flex flex-col items-center gap-0.5 py-2">
          <Tooltip label="New chat">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center"
              onclick={() => appStore.createChat()}
              aria-label="New chat"
            >
              <Plus class="h-4 w-4" />
            </button>
          </Tooltip>

          <div class="flex-1"></div>

          <Tooltip label="Models">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center"
              onclick={() => openModelHub('models')}
              aria-label="Models"
            >
              <Boxes class="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label="Settings">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center"
              onclick={() => openModelHub('general')}
              aria-label="Settings"
            >
              <Settings class="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Main area: chat only (sandbox opens as modal) -->
        <div class="chat-panel relative flex min-h-0 flex-1 flex-col overflow-hidden" class:welcome-bg={!hasMessages}>
          {#if !hasMessages}
            <div class="welcome-dots-layer" aria-hidden="true">
              <span class="dots tl"></span>
              <span class="dots tr"></span>
              <span class="dots bl"></span>
              <span class="dots br"></span>
            </div>
          {/if}
          <div class="chat-content-layer relative z-10 flex min-h-0 flex-1 flex-col">
            <CodeTopbar onToggleDrawer={() => (codeDrawerOpen = !codeDrawerOpen)} />
            <MessageList composerInset={composerHeight} />
            <Composer onHeightChange={(height) => (composerHeight = height)} centered={!hasMessages} />
          </div>
        </div>
      </div>

      {#if appStore.activeSpace !== 'code' && appStore.activityDrawerOpen}
        <div class="activity-drawer-slot" transition:drawerSlotTransition>
          <ActivityDrawer />
        </div>
      {:else if appStore.activeSpace === 'code' && codeDrawerOpen}
        <div class="activity-drawer-slot" transition:drawerSlotTransition>
          <CodeWorkspaceDrawer />
        </div>
      {/if}
    {/if}
  </div>

  {#if appStore.workspaceMode === 'modern'}
    {#if appStore.promptConfigOpen}
      <SystemPromptModal />
    {/if}
    <LocalModelLoadModal />

    {#if appStore.modelManagerOpen}
      <ModelHubModal />
    {/if}
  {/if}
</div>

<Toaster />
<ConfirmDialog />
<LLMDrawer />

{#if pendingApproval}
  <CodeBashApprovalModal approval={pendingApproval} />
{/if}

{#if appStore.sandboxOpen && appStore.currentArtifact}
  <SandboxModal />
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
  <div class="fixed inset-0 z-[300] flex items-center justify-center bg-overlay px-4" onclick={() => (showShortcutsHelp = false)}>
    <div
      class="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6"
      role="dialog" aria-modal="true" tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') showShortcutsHelp = false; }}
    >
      <h2 class="mb-4 text-base font-semibold text-[var(--text)]">Keyboard shortcuts</h2>
      <dl class="space-y-3 text-sm">
        {#each [
          ['Ctrl+K', 'New chat'],
          ['Ctrl+Shift+K', 'Search chats'],
          ['Ctrl+,', 'Open Settings'],
          ['Ctrl+B', 'Show or hide sidebar'],
          ['Ctrl+`', 'Toggle code sandbox'],
          ['Ctrl+E', 'Export chat'],
          ['Ctrl+?', 'This help'],
          ['Escape', 'Close dialog / Stop stream'],
        ] as [key, label]}
          <div class="flex items-center justify-between gap-4">
            <span class="text-[var(--text-secondary)]">{label}</span>
            <kbd class="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]">{key}</kbd>
          </div>
        {/each}
      </dl>
      <p class="mt-4 text-[12px] text-[var(--text-muted)]">On macOS, Ctrl = ⌘ Cmd</p>
    </div>
  </div>
{/if}

<style>
  .sidebar-outer {
    width: 44px;
    background: var(--sidebar-bg, var(--surface));
    border: 1px solid transparent;
    border-radius: var(--radius-2xl);
    box-shadow: none;
    transition: width 0.5s cubic-bezier(0.32, 0.72, 0, 1), border-color 0.2s ease, box-shadow 0.2s ease;
    will-change: width;
  }
  .sidebar-outer.expanded {
    width: 260px;
    border-color: var(--border);
    box-shadow: var(--shadow-md);
  }

  .sidebar-view-full {
    opacity: 0;
    visibility: hidden;
    transform: translateX(-8px) scale(0.98);
    transition: opacity 0.22s ease, transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 0.3s;
    pointer-events: none;
    overflow: hidden;
  }
  .sidebar-outer.expanded .sidebar-view-full {
    opacity: 1;
    visibility: visible;
    transform: translateX(0) scale(1);
    transition-delay: 0.08s, 0.08s, 0s;
    pointer-events: auto;
  }

  .sidebar-view-collapsed {
    opacity: 1;
    visibility: visible;
    transform: translateX(0);
    transition: opacity 0.18s ease, transform 0.25s ease, visibility 0s linear;
  }

  .collapsed-btn {
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 8px;
  }

  .collapsed-btn:hover {
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(245, 245, 245, 0.95), rgba(196, 196, 196, 0.92), rgba(232, 232, 232, 0.95)) border-box;
    border-color: transparent;
    color: var(--text);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 0 rgba(0,0,0,0.04), var(--shadow-xs);
  }

  :global(.collapsed-btn svg) {
    color: var(--text);
  }

  :global(.dark) .collapsed-btn,
  :global(.dark .collapsed-btn svg) {
    color: #ffffff;
  }

  :global(.dark) .collapsed-btn:hover {
    background:
      linear-gradient(var(--sidebar-bg, var(--surface)), var(--sidebar-bg, var(--surface))) padding-box,
      linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(0, 0, 0, 0.45), rgba(255, 255, 255, 0.24)) border-box;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.35), var(--shadow-xs);
  }

  .sidebar-outer.expanded .sidebar-view-collapsed {
    opacity: 0;
    visibility: hidden;
    transform: translateX(-6px);
    pointer-events: none;
    transition-delay: 0s, 0s, 0.18s;
  }

  .chat-panel {
    border: 1px solid var(--border);
    border-radius: 22px;
    background: var(--surface);
  }

  .activity-drawer-slot {
    display: flex;
    height: 100%;
    flex: 0 0 auto;
    overflow: hidden;
    transform-origin: right center;
    will-change: width, min-width, opacity, transform;
  }

  .welcome-dots-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 18;
  }

  .welcome-dots-layer .dots {
    position: absolute;
    width: 220px;
    height: 170px;
    border-radius: 18px;
    opacity: 0.52;
    background: radial-gradient(circle, rgba(0, 0, 0, 0.95) 0 0.9px, transparent 1.55px) 0 0 / 12px 12px;
    animation: cornerDotsDrift 8s ease-in-out infinite alternate;
    transform: translateZ(0);
  }

  .welcome-dots-layer .dots.tl {
    top: 20px;
    left: 18px;
    clip-path: ellipse(56% 54% at 0% 0%);
  }

  .welcome-dots-layer .dots.tr {
    top: 20px;
    right: 18px;
    clip-path: ellipse(56% 54% at 100% 0%);
  }

  .welcome-dots-layer .dots.bl {
    bottom: 20px;
    left: 18px;
    clip-path: ellipse(56% 54% at 0% 100%);
    animation-delay: 0.4s;
  }

  .welcome-dots-layer .dots.br {
    bottom: 20px;
    right: 18px;
    clip-path: ellipse(56% 54% at 100% 100%);
    animation-delay: 0.7s;
  }

  :global(.dark) .welcome-dots-layer .dots {
    background: radial-gradient(circle, rgba(255, 255, 255, 0.95) 0 0.9px, transparent 1.55px) 0 0 / 12px 12px;
  }

  @keyframes cornerDotsDrift {
    from { transform: translateY(0); opacity: 0.35; }
    to { transform: translateY(-5px); opacity: 0.5; }
  }
</style>
