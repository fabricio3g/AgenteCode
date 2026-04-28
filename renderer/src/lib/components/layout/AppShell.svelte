<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import Titlebar from '$lib/components/layout/Titlebar.svelte';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import Navbar from '$lib/components/layout/Navbar.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import Composer from '$lib/components/chat/Composer.svelte';
  import ChatSandbox from '$lib/components/agent/ChatSandbox.svelte';
  import SettingsModal from '$lib/components/settings/SettingsModal.svelte';
  import SystemPromptModal from '$lib/components/settings/SystemPromptModal.svelte';
  import LocalModelLoadModal from '$lib/components/settings/LocalModelLoadModal.svelte';
  import ModelHubModal from '$lib/components/settings/ModelHubModal.svelte';
  import LocalRuntimeModal from '$lib/components/settings/LocalRuntimeModal.svelte';
  import DownloadsModal from '$lib/components/settings/DownloadsModal.svelte';
  import LegacyWorkspace from '$lib/components/legacy/LegacyWorkspace.svelte';
  import Toaster from '$lib/components/layout/Toaster.svelte';
  import ConfirmDialog from '$lib/components/layout/ConfirmDialog.svelte';
  import LLMDrawer from '$lib/components/layout/LLMDrawer.svelte';
  import ChatSearchModal from '$lib/components/layout/ChatSearchModal.svelte';
  import SearchSidebar from '$lib/components/search/SearchSidebar.svelte';
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Plus, Search, Boxes, Cpu, Settings2, PanelLeftOpen } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { capabilitiesStore } from '$lib/stores/capabilities.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isTauri } from '$lib/services/tauri';

  let showShortcutsHelp = $state(false);
  let sandboxSplit = $state(50); // percentage for chat pane width
  let composerHeight = $state(320);

  // Sandbox visible = open AND artifact exists
  const sandboxVisible = $derived(appStore.sandboxOpen && !!appStore.currentArtifact);
  const hasMessages = $derived((appStore.currentChat?.messages?.length || 0) > 0);

  // Drag-to-resize split pane
  function startResize(event: MouseEvent) {
    event.preventDefault();
    const container = (event.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    function onMove(e: MouseEvent) {
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      sandboxSplit = Math.min(80, Math.max(20, pct));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
      event.preventDefault(); appStore.settingsOpen = true; return;
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

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    if (isTauri()) {
      void hardwareStore.refresh();
      void capabilitiesStore.refresh();
    }
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="ambient-gradient"></div>

  <Titlebar />

  <div class="flex min-h-0 flex-1">
    {#if appStore.workspaceMode === 'legacy'}
      <LegacyWorkspace />
    {:else}
      {#if appStore.sidebarOpen}
        <Sidebar />
      {:else}
        <!-- Collapsed sidebar icon strip -->
        <div class="collapsed-sidebar flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--sidebar-bg,var(--surface))] py-3">
          <Tooltip label="Show sidebar">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
              onclick={() => (appStore.sidebarOpen = true)}
              aria-label="Show sidebar"
            >
              <PanelLeftOpen class="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label="New chat">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
              onclick={() => appStore.createChat()}
              aria-label="New chat"
            >
              <Plus class="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label="Search conversations">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
              onclick={() => (appStore.chatSearchOpen = true)}
              aria-label="Search chats"
            >
              <Search class="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label="Model Hub">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
              onclick={() => { appStore.modelManagerOpen = true; appStore.modelManagerOpenSection = 'models'; }}
              aria-label="Model Hub"
            >
              <Boxes class="h-4 w-4" />
            </button>
          </Tooltip>
          {#if isTauri()}
            <Tooltip label="Runtime">
              <button
                class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
                onclick={() => (appStore.runtimeManagerOpen = true)}
                aria-label="Runtime"
              >
                <Cpu class="h-4 w-4" />
              </button>
            </Tooltip>
          {/if}
          <div class="flex-1"></div>
          <Tooltip label="Settings">
            <button
              class="collapsed-btn flex h-8 w-8 items-center justify-center transition"
              onclick={() => (appStore.settingsOpen = true)}
              aria-label="Settings"
            >
              <Settings2 class="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      {/if}

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Navbar />

        <!-- Main area: chat + optional sandbox split -->
        <div class="flex min-h-0 flex-1 overflow-hidden">
          <!-- Chat pane -->
          <div class="relative flex min-h-0 min-w-0 flex-col overflow-hidden" style={sandboxVisible ? `width: ${sandboxSplit}%` : 'flex: 1'}>
            <MessageList composerInset={composerHeight} />
            <Composer onHeightChange={(height) => (composerHeight = height)} centered={!hasMessages} />
          </div>

          {#if sandboxVisible}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--surface-hover)] transition hover:bg-[var(--primary)] active:bg-[var(--primary)]"
              onmousedown={startResize}
              role="separator"
              aria-orientation="vertical"
            >
              <div class="h-8 w-0.5 rounded-full bg-[var(--border)] transition group-hover:bg-[var(--primary)]"></div>
            </div>

            <div class="flex h-full min-w-0 flex-col overflow-hidden" style="width: {100 - sandboxSplit}%">
              <ChatSandbox />
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if appStore.workspaceMode === 'modern'}
    {#if appStore.promptConfigOpen}
      <SystemPromptModal />
    {/if}
    {#if appStore.settingsOpen}
      <SettingsModal />
    {/if}
    {#if appStore.downloadsOpen}
      <DownloadsModal />
    {/if}

    <LocalModelLoadModal />

    {#if appStore.modelManagerOpen}
      <ModelHubModal />
    {/if}
    {#if appStore.runtimeManagerOpen}
      <LocalRuntimeModal />
    {/if}
  {/if}
</div>

<Toaster />
<ConfirmDialog />
<LLMDrawer />

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
          ['Ctrl+,', 'Open settings'],
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
