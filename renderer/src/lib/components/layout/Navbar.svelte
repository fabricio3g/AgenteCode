<svelte:options runes={true} />

<script lang="ts">
  import { Code2, FileDown, MoonStar, PanelLeftClose, SlidersHorizontal, SunMedium } from 'lucide-svelte';
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
      <button class="nav-btn invisible p-2" aria-hidden="true" tabindex="-1">
        <PanelLeftClose class="h-5 w-5" />
      </button>
    </div>

    <div class="flex min-w-0 flex-1 items-center justify-center px-3">
      <ModelSwitcher />
    </div>

    <div class="flex items-center gap-0.5">
      {#if hasArtifact}
        <button
          class="nav-btn p-2 {appStore.sandboxOpen ? 'is-active' : ''}"
          onclick={() => (appStore.sandboxOpen = !appStore.sandboxOpen)}
          aria-label="Toggle code sandbox"
          title="Toggle code sandbox"
        >
          <Code2 class="h-5 w-5" />
        </button>
      {/if}
      {#if hasMessages}
        <button
          class="nav-btn p-2"
          onclick={exportCurrentChat}
          aria-label="Export chat"
          title="Export chat"
        >
          <FileDown class="h-5 w-5" />
        </button>
      {/if}
      <button class="nav-btn p-2" onclick={() => themeStore.toggle()} aria-label="Toggle theme" title="Toggle theme">
        {#if themeStore.current === 'dark'}
          <SunMedium class="h-5 w-5" />
        {:else}
          <MoonStar class="h-5 w-5" />
        {/if}
      </button>
      <button class="nav-btn p-2" onclick={() => (appStore.llmDrawerOpen = true)} aria-label="LLM settings" title="Settings">
        <SlidersHorizontal class="h-5 w-5" />
      </button>
    </div>
  </div>
</header>

<style>
  .navbar {
    background: var(--background);
    border-bottom: 1px solid var(--border);
  }

  .nav-btn {
    color: var(--text);
    background: transparent;
    border: none;
    border-radius: 4px;
    transition: background 0.15s ease;
  }

  .nav-btn:hover {
    background: var(--surface-hover);
  }

  .nav-btn.is-active {
    background: var(--surface-hover);
  }

  .nav-btn svg {
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .nav-btn:hover svg {
    transform: rotate(-8deg);
  }
</style>
