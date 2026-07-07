<svelte:options runes={true} />

<script lang="ts">
  import { Box, GitBranch, PanelRight, Plus, Shield } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { openWorkspaceFile } from '$lib/services/files';
  import { invoke } from '$lib/services/tauri';

  interface Props { onToggleDrawer?: () => void; drawerOpen?: boolean }

  let { onToggleDrawer, drawerOpen = false }: Props = $props();

  const project = $derived(appStore.currentProject);
  const chat = $derived(appStore.currentChat);
  const title = $derived(chat?.title || 'Codebase overview');
  const projectName = $derived(project?.rootName || chat?.workspace?.rootName || 'No project');
  const runtimeMode = $derived(chat?.codeAgent?.runtimeMode || 'full');

  async function openProject() {
    const path = project?.rootPath || chat?.workspace?.rootPath;
    if (!path) {
      toastStore.info('Select a Code project first.', 2200);
      return;
    }
    await openWorkspaceFile(path);
  }

  async function commitAndPush() {
    const root = project?.rootPath || chat?.workspace?.rootPath;
    if (!root) {
      toastStore.info('No project directory available.', 2200);
      return;
    }
    try {
      await invoke('workspace_exec', { workspace_root: root, command: 'git', args: ['add', '-A'], timeout_ms: 15000 });
      await invoke('workspace_exec', { workspace_root: root, command: 'git', args: ['commit', '-m', `chatea: ${title}`], timeout_ms: 15000 });
      await invoke('workspace_exec', { workspace_root: root, command: 'git', args: ['push'], timeout_ms: 30000 });
      toastStore.success('Commited and pushed.', 2500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toastStore.error(`Git failed: ${msg}`, 3500);
    }
  }

  function addAction() {
    toastStore.info('Type your action in the composer below.', 2200);
  }

  function toggleRuntimeMode() {
    appStore.setCodeAgentRuntimeMode(runtimeMode === 'full' ? 'supervised' : 'full');
  }
</script>

{#if appStore.activeSpace === 'code'}
  <header class="code-topbar">
    <div class="code-title-wrap">
      <h1>{title}</h1>
      <span>{projectName}</span>
    </div>

    <div class="code-actions">
      <button type="button" class="mode-toggle" class:supervised={runtimeMode === 'supervised'} onclick={toggleRuntimeMode} title={runtimeMode === 'supervised' ? 'Supervised: ask before bash' : 'Full access'}>
        <Shield class="h-3 w-3" />
        <span>{runtimeMode === 'supervised' ? 'Ask' : 'Full'}</span>
      </button>
      <button type="button" class="code-action icon-action" onclick={addAction} title="Add action">
        <Plus class="h-3 w-3" />
        <span class="label">Action</span>
      </button>
      <button type="button" class="code-action icon-action" onclick={openProject} title="Open project">
        <Box class="h-3 w-3" />
        <span class="label">Open</span>
      </button>
      <button type="button" class="code-action icon-action" onclick={commitAndPush} title="Commit and push">
        <GitBranch class="h-3 w-3" />
        <span class="label">Push</span>
      </button>
      {#if onToggleDrawer}
        <button type="button" class="code-action icon-only" class:active={drawerOpen} onclick={onToggleDrawer} title="Code panel">
          <PanelRight class="h-3 w-3" />
        </button>
      {/if}
    </div>
  </header>
{/if}

<style>
  .code-topbar {
    display: flex;
    min-height: 2.35rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0.34rem 0.65rem;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
  }

  .code-title-wrap {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 720;
  }

  .code-title-wrap span {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.08rem 0.35rem;
    font-size: 0.63rem;
    font-weight: 680;
  }

  .code-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
  }

  .code-action,
  .mode-toggle {
    display: inline-flex;
    height: 1.55rem;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    padding: 0 0.42rem;
    font-size: 0.64rem;
    font-weight: 680;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }

  .code-action:hover,
  .code-action.active,
  .mode-toggle:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
    color: var(--text);
  }

  .mode-toggle.supervised {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
    background: color-mix(in srgb, var(--primary) 8%, transparent);
    color: var(--primary);
  }

  .icon-only {
    width: 1.55rem;
    justify-content: center;
    padding: 0;
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
