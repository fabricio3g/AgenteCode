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
  <header class="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
    <div class="flex min-w-0 items-center gap-2">
      <h1 class="m-0 truncate text-sm font-semibold text-foreground">{title}</h1>
      <span class="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
        {projectName}
      </span>
    </div>

    <div class="flex items-center gap-0.5">
      <button
        type="button"
        class="aui-select-trigger h-7 gap-1 px-2 {runtimeMode === 'supervised' ? 'bg-muted text-foreground' : ''}"
        onclick={toggleRuntimeMode}
        title={runtimeMode === 'supervised' ? 'Supervised: ask before bash' : 'Full access'}
      >
        <Shield class="size-3" />
        <span>{runtimeMode === 'supervised' ? 'Ask' : 'Full'}</span>
      </button>
      <button type="button" class="aui-icon-button size-7" onclick={addAction} title="Add action">
        <Plus class="size-3.5" />
      </button>
      <button type="button" class="aui-icon-button size-7" onclick={openProject} title="Open project">
        <Box class="size-3.5" />
      </button>
      <button type="button" class="aui-icon-button size-7" onclick={commitAndPush} title="Commit and push">
        <GitBranch class="size-3.5" />
      </button>
      {#if onToggleDrawer}
        <button
          type="button"
          class="aui-icon-button size-7 {drawerOpen ? 'bg-muted text-foreground' : ''}"
          onclick={onToggleDrawer}
          title="Code panel"
        >
          <PanelRight class="size-3.5" />
        </button>
      {/if}
    </div>
  </header>
{/if}
