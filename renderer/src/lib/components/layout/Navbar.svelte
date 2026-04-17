<svelte:options runes={true} />

<script lang="ts">
  import { Code2, FileDown, MoonStar, PanelLeftClose, PanelLeftOpen, SlidersHorizontal, SunMedium } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isTauri } from '$lib/services/tauri';
  import { writeTempFile } from '$lib/services/files';
  import ModelSwitcher from '$lib/components/chat/ModelSwitcher.svelte';

  const hasMessages = $derived((appStore.currentChat?.messages?.length || 0) > 0);
  const hasArtifact = $derived(!!appStore.currentArtifact);

  async function exportCurrentChat() {
    const chat = appStore.currentChat;
    if (!chat) return;
    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [`# ${chat.title || 'Chat'}\n\n_Exported ${date}_\n`];
    for (const m of chat.messages) {
      if (m.role === 'user') {
        lines.push(`\n---\n\n**You:**\n\n${m.content}`);
      } else {
        const label = m.model ? `**Assistant** (${m.model})` : '**Assistant**';
        lines.push(`\n---\n\n${label}:\n\n${m.content}`);
      }
    }
    const filename = `${(chat.title || 'chat').replace(/[^a-z0-9]+/gi, '_')}_${date}.md`;
    const content = lines.join('\n');
    try {
      if (isTauri()) {
        const enc = new TextEncoder();
        const path = await writeTempFile(filename, enc.encode(content));
        try {
          const { openWorkspaceFile } = await import('$lib/services/files');
          await openWorkspaceFile(path);
          toastStore.success(`Chat exported: ${filename}`, 2500);
        } catch {
          toastStore.success(`Saved to ${path}`, 3500);
        }
      } else {
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.setAttribute('download', filename);
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        toastStore.success(`Chat exported as ${filename}`, 2500);
      }
    } catch {
      toastStore.error('Export failed — try copying the chat manually.');
    }
  }
</script>

<header class="navbar sticky top-0 z-30 w-full">
  <div class="navbar-inner relative flex h-11 items-center justify-between px-2 md:px-3">
    <div class="flex items-center gap-1">
      <button
        class="nav-btn rounded-lg p-2"
        onclick={() => (appStore.sidebarOpen = !appStore.sidebarOpen)}
        aria-label={appStore.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        title={appStore.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
      >
        {#if appStore.sidebarOpen}
          <PanelLeftClose class="h-5 w-5" />
        {:else}
          <PanelLeftOpen class="h-5 w-5" />
        {/if}
      </button>
    </div>

    <div class="flex min-w-0 flex-1 items-center justify-center px-3">
      <ModelSwitcher />
    </div>

    <div class="flex items-center gap-0.5">
      {#if hasArtifact}
        <button
          class="nav-btn rounded-lg p-2 {appStore.sandboxOpen ? 'is-active' : ''}"
          onclick={() => (appStore.sandboxOpen = !appStore.sandboxOpen)}
          aria-label="Toggle code sandbox"
          title="Toggle code sandbox"
        >
          <Code2 class="h-5 w-5" />
        </button>
      {/if}
      {#if hasMessages}
        <button
          class="nav-btn rounded-lg p-2"
          onclick={exportCurrentChat}
          aria-label="Export chat"
          title="Export chat"
        >
          <FileDown class="h-5 w-5" />
        </button>
      {/if}
      <button class="nav-btn rounded-lg p-2" onclick={() => themeStore.toggle()} aria-label="Toggle theme" title="Toggle theme">
        {#if themeStore.current === 'dark'}
          <SunMedium class="h-5 w-5" />
        {:else}
          <MoonStar class="h-5 w-5" />
        {/if}
      </button>
      <button class="nav-btn rounded-lg p-2" onclick={() => (appStore.llmDrawerOpen = true)} aria-label="LLM settings" title="Settings">
        <SlidersHorizontal class="h-5 w-5" />
      </button>
    </div>
  </div>
</header>

<style>
  .navbar {
    background: var(--background);
    border-bottom: 1px solid var(--border-light);
  }

  .nav-btn {
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }

  .nav-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
    border-color: var(--border-light);
  }

  .nav-btn.is-active {
    color: var(--text);
    background: var(--surface-secondary);
    border-color: var(--border);
  }
</style>
