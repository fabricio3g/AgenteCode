<svelte:options runes={true} />

<script lang="ts">
  import { Box, ChevronDown, GitBranch, Plus } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { openWorkspaceFile } from '$lib/services/files';

  const project = $derived(appStore.currentProject);
  const chat = $derived(appStore.currentChat);
  const title = $derived(chat?.title || 'Codebase overview');
  const projectName = $derived(project?.rootName || chat?.workspace?.rootName || 'No project');

  async function openProject() {
    const path = project?.rootPath || chat?.workspace?.rootPath;
    if (!path) {
      toastStore.info('Select a Code project first.', 2200);
      return;
    }
    await openWorkspaceFile(path);
  }

  function notReady(label: string) {
    toastStore.info(`${label} is not wired yet.`, 2200);
  }
</script>

{#if appStore.activeSpace === 'code'}
  <header class="code-topbar">
    <div class="code-title-wrap">
      <h1>{title}</h1>
      <span>{projectName}</span>
    </div>

    <div class="code-actions">
      <button type="button" class="code-action" onclick={() => notReady('Add action')}>
        <Plus class="h-3.5 w-3.5" />
        Add action
      </button>
      <button type="button" class="code-action" onclick={openProject}>
        <Box class="h-3.5 w-3.5" />
        Open
        <ChevronDown class="h-3 w-3" />
      </button>
      <button type="button" class="code-action" onclick={() => notReady('Commit & push')}>
        <GitBranch class="h-3.5 w-3.5" />
        Commit & push
        <ChevronDown class="h-3 w-3" />
      </button>
    </div>
  </header>
{/if}

<style>
  .code-topbar {
    display: flex;
    min-height: 3.1rem;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0.52rem 1.1rem;
    background: color-mix(in srgb, var(--surface) 84%, transparent);
  }

  .code-title-wrap {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 0.98rem;
    font-weight: 780;
  }

  .code-title-wrap span {
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--surface-hover);
    color: var(--text-secondary);
    padding: 0.12rem 0.4rem;
    font-size: 0.72rem;
    font-weight: 760;
  }

  .code-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .code-action {
    display: inline-flex;
    height: 2rem;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.62rem;
    background: color-mix(in srgb, var(--surface-hover) 46%, transparent);
    color: var(--text-secondary);
    padding: 0 0.62rem;
    font-size: 0.78rem;
    font-weight: 760;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }

  .code-action:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
    color: var(--text);
  }

  @media (max-width: 760px) {
    .code-topbar {
      align-items: flex-start;
      flex-direction: column;
    }

    .code-actions {
      width: 100%;
      overflow-x: auto;
    }
  }
</style>
