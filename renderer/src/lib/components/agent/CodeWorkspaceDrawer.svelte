<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, AlertCircle, Bot, CheckCircle2, ChevronDown, Code2, FileCode2, Files, GitCompare, Shield, Terminal } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { detectProviderStatus, listCodeAgentProviders } from '$lib/services/agent-provider';
  import { isTauri, invoke } from '$lib/services/tauri';
  import type { AgentStep, CodeAgentFileChangeKind, CodeAgentProvider, CodeAgentProviderId, CodeAgentProviderStatus, CodeAgentRuntimeMode } from '$lib/types/chat';
  import ToolCallRow from './ToolCallRow.svelte';

  type DrawerTab = 'activity' | 'diff' | 'files' | 'terminal';

  const providers: CodeAgentProvider[] = $state(
    listCodeAgentProviders()
  );

  let activeTab = $state<DrawerTab>('activity');
  let providerMenuOpen = $state(false);
  let commandInput = $state('');
  let commandOutput = $state('');
  let commandRunning = $state(false);
  let terminalHistory = $state<Array<{ command: string; output: string; error?: boolean }>>([]);
  let expandedDiffFile = $state<string | null>(null);

  const currentChat = $derived(appStore.currentChat);
  const workspaceRoot = $derived(appStore.currentProject?.rootPath || currentChat?.workspace?.rootPath || '');
  const activeProviderId = $derived<CodeAgentProviderId>(currentChat?.codeAgent?.instanceId || 'chatea-agent');
  const activeProvider = $derived(providers.find((provider) => provider.id === activeProviderId) || providers[0]);
  const latestAgentMessage = $derived.by(() => {
    const messages = currentChat?.messages || [];
    return [...messages].reverse().find((message) => message.mode === 'agent' || message.agentSteps?.length || message.artifact) || null;
  });
  const steps = $derived<AgentStep[]>(latestAgentMessage?.agentSteps || []);
  const artifact = $derived(appStore.currentArtifact || latestAgentMessage?.artifact || null);
  const artifactFiles = $derived(Object.keys(artifact?.files || {}).filter((path) => !path.startsWith('__')).sort((a, b) => a.localeCompare(b)));
  const executingSteps = $derived(steps.filter((step) => step.type === 'executing'));
  const runningStep = $derived(steps.find((step) => step.status === 'running' || step.status === 'awaiting_approval'));
  const trackedFileChanges = $derived(steps.flatMap((step) => step.fileChanges || []));
  const fileChanges = $derived.by(() => {
    const byPath = new Map<string, { path: string; kind: CodeAgentFileChangeKind }>();
    for (const change of trackedFileChanges) {
      byPath.set(change.path, change);
    }
    for (const path of artifactFiles) {
      if (!byPath.has(path)) byPath.set(path, { path, kind: 'created' });
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  });
  const changedFilePaths = $derived(fileChanges.map((change) => change.path));
  const runtimeMode = $derived<CodeAgentRuntimeMode>(currentChat?.codeAgent?.runtimeMode || 'full');

  function statusLabel(status: CodeAgentProviderStatus) {
    switch (status) {
      case 'ready': return 'Ready';
      case 'missing': return 'Not installed';
      case 'login': return 'Login required';
      case 'soon': return 'Coming soon';
      case 'disabled': return 'Not configured';
    }
  }

  function statusIcon(status: CodeAgentProviderStatus) {
    switch (status) {
      case 'ready': return CheckCircle2;
      case 'soon': return Code2;
      case 'missing':
      case 'login':
      case 'disabled':
      default: return AlertCircle;
    }
  }

  function changeLabel(kind: CodeAgentFileChangeKind) {
    switch (kind) {
      case 'created': return 'Created';
      case 'modified': return 'Modified';
      case 'deleted': return 'Deleted';
    }
  }

  function artifactHasFile(path: string) {
    return !!artifact?.files?.[path];
  }

  function getFileContent(path: string): string | null {
    return artifact?.files?.[path] || null;
  }

  function toggleDiffFile(path: string) {
    expandedDiffFile = expandedDiffFile === path ? null : path;
  }

  async function runTerminalCommand() {
    const cmd = commandInput.trim();
    if (!cmd || commandRunning) return;
    commandRunning = true;
    commandInput = '';
    commandOutput = '';
    try {
      if (isTauri()) {
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>('workspace_exec', {
          workspace_root: workspaceRoot,
          command: cmd,
          shell: true,
          timeout_ms: 30000
        });
        const output = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
        commandOutput = output || `(exit code ${result.exit_code})`;
        terminalHistory = [...terminalHistory, { command: cmd, output: commandOutput, error: result.exit_code !== 0 }];
      } else {
        commandOutput = 'Terminal available in desktop app only.';
        terminalHistory = [...terminalHistory, { command: cmd, output: commandOutput, error: true }];
      }
    } catch (error) {
      commandOutput = String((error as { message?: string })?.message || error);
      terminalHistory = [...terminalHistory, { command: cmd, output: commandOutput, error: true }];
    } finally {
      commandRunning = false;
    }
  }

  function handleTerminalKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      runTerminalCommand();
    }
  }

  function toggleRuntimeMode() {
    appStore.setCodeAgentRuntimeMode(runtimeMode === 'full' ? 'supervised' : 'full');
  }

  function selectProvider(providerId: CodeAgentProviderId) {
    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider || provider.status !== 'ready') return;
    appStore.setCodeAgentProvider(providerId);
    providerMenuOpen = false;
  }

  onMount(() => {
    for (const provider of providers) {
      detectProviderStatus(provider.id).then((status) => {
        const match = providers.find((entry) => entry.id === provider.id);
        if (match) match.status = status;
      });
    }
  });
</script>

<aside class="code-drawer flex h-full w-full min-w-0 flex-col overflow-hidden bg-background" aria-label="Code workspace">
  <header class="flex shrink-0 items-center gap-2 px-3 py-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-foreground">Code workspace</div>
      <div class="mt-0.5 truncate text-xs text-muted-foreground">
        {currentChat?.title || 'New code'}{#if runningStep} · {runningStep.label}{/if}
      </div>
    </div>

    <button
      type="button"
      class="aui-select-trigger h-7 gap-1 px-2 {runtimeMode === 'supervised' ? 'bg-muted text-foreground' : ''}"
      onclick={toggleRuntimeMode}
      title={runtimeMode === 'supervised' ? 'Supervised mode' : 'Full access'}
    >
      <Shield class="size-3" />
      <span>{runtimeMode === 'supervised' ? 'Sup' : 'Full'}</span>
    </button>

    <div class="provider-picker relative shrink-0">
      <button
        type="button"
        class="aui-select-trigger h-7 max-w-[10rem] gap-1 px-2"
        class:open={providerMenuOpen}
        onclick={() => (providerMenuOpen = !providerMenuOpen)}
        aria-haspopup="listbox"
        aria-expanded={providerMenuOpen}
      >
        <Bot class="size-3.5 shrink-0" />
        <span class="truncate">{activeProvider.label}</span>
        <ChevronDown class={`size-3 shrink-0 transition-transform ${providerMenuOpen ? 'rotate-180' : ''}`} />
      </button>

      {#if providerMenuOpen}
        <div class="aui-menu absolute right-0 top-full z-80 mt-1 w-min min-w-[16rem] max-w-[min(24rem,46vw)]" role="listbox">
          {#each providers as provider (provider.id)}
            {@const StatusIcon = statusIcon(provider.status)}
            <button
              type="button"
              class="aui-menu-item !items-start {activeProviderId === provider.id ? 'is-active' : ''} {provider.status !== 'ready' ? 'opacity-60' : ''}"
              onclick={() => selectProvider(provider.id)}
              role="option"
              aria-selected={activeProviderId === provider.id}
              disabled={provider.status !== 'ready'}
            >
              <Bot class="mt-0.5 size-3.5 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium">{provider.label}</span>
                <span class="block truncate text-[0.65rem] opacity-70">{provider.driver} · {provider.detail}</span>
              </span>
              <span class="inline-flex shrink-0 items-center gap-1 text-[0.65rem] {provider.status === 'ready' ? 'text-success' : ''}">
                <StatusIcon class="size-3" />
                {statusLabel(provider.status)}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </header>

  <div class="px-3 pb-2">
    <div class="aui-segmented grid w-full grid-cols-4 gap-0.5" role="tablist" aria-label="Code workspace panels">
      <button type="button" class="aui-segmented-item flex items-center justify-center gap-1 py-1.5 text-[0.65rem] {activeTab === 'activity' ? 'is-active' : ''}" onclick={() => (activeTab = 'activity')}><Activity class="size-3.5" /><span class="hidden sm:inline">Activity</span></button>
      <button type="button" class="aui-segmented-item flex items-center justify-center gap-1 py-1.5 text-[0.65rem] {activeTab === 'diff' ? 'is-active' : ''}" onclick={() => (activeTab = 'diff')}><GitCompare class="size-3.5" /><span class="hidden sm:inline">Diff</span></button>
      <button type="button" class="aui-segmented-item flex items-center justify-center gap-1 py-1.5 text-[0.65rem] {activeTab === 'files' ? 'is-active' : ''}" onclick={() => (activeTab = 'files')}><Files class="size-3.5" /><span class="hidden sm:inline">Files</span></button>
      <button type="button" class="aui-segmented-item flex items-center justify-center gap-1 py-1.5 text-[0.65rem] {activeTab === 'terminal' ? 'is-active' : ''}" onclick={() => (activeTab = 'terminal')}><Terminal class="size-3.5" /><span class="hidden sm:inline">Terminal</span></button>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
    {#if activeTab === 'activity'}
      {#if steps.length}
        <div class="flex flex-col gap-0.5">
          {#each steps as step (step.id)}
            <ToolCallRow {step} />
          {/each}
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center gap-2 px-2 py-10 text-center text-muted-foreground">
          <Bot class="size-6 opacity-50" />
          <p class="m-0 text-sm">Code agent activity will appear here.</p>
        </div>
      {/if}
    {:else if activeTab === 'diff'}
      {#if fileChanges.length}
        <div class="flex flex-col gap-0.5">
          {#each fileChanges as change (`${change.kind}:${change.path}`)}
            {@const expanded = expandedDiffFile === change.path}
            {@const fileContent = getFileContent(change.path)}
            <section class="overflow-hidden rounded-md {expanded ? 'bg-muted/50' : ''}">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-70"
                onclick={() => toggleDiffFile(change.path)}
                disabled={!fileContent}
              >
                <span class="change-kind {change.kind}">{changeLabel(change.kind)}</span>
                <span class="min-w-0 flex-1 truncate text-xs text-foreground">{change.path}</span>
                {#if fileContent}
                  <ChevronDown class={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                {/if}
              </button>
              {#if expanded && fileContent}
                <pre class="diff-content m-0 max-h-72 overflow-auto border-t border-border/40 px-2.5 py-2 font-mono text-[0.7rem] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">{fileContent.slice(0, 6000)}{fileContent.length > 6000 ? '\n\n… (truncated)' : ''}</pre>
              {/if}
            </section>
          {/each}
        </div>
      {:else}
        <section class="rounded-md bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
          <div class="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground"><GitCompare class="size-3.5" />Diff tracking</div>
          <p class="m-0 text-xs leading-relaxed">Changed files and turn diffs appear here when the agent reports create/modify/delete paths.</p>
        </section>
      {/if}
    {:else if activeTab === 'files'}
      {#if changedFilePaths.length}
        <div class="flex flex-col gap-0.5">
          {#each changedFilePaths as file}
            {@const change = fileChanges.find((entry) => entry.path === file)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted disabled:opacity-60"
              disabled={!artifactHasFile(file)}
              onclick={() => (appStore.sandboxOpen = true)}
            >
              <FileCode2 class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-foreground">{file}</span>
              {#if change}
                <span class="change-kind {change.kind}">{changeLabel(change.kind)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center gap-2 px-2 py-10 text-center text-muted-foreground">
          <Files class="size-6 opacity-50" />
          <p class="m-0 text-sm">Files created or opened by the code agent will appear here.</p>
        </div>
      {/if}
    {:else if activeTab === 'terminal'}
      <div class="flex h-full min-h-[12rem] flex-col gap-2">
        {#if executingSteps.length}
          <div class="flex flex-col gap-1">
            {#each executingSteps as step (step.id)}
              <section class="rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[0.7rem]">
                <div class="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground"><Terminal class="size-3.5" />{step.label}</div>
                <p class="m-0 text-muted-foreground">{step.detail || 'Command'}</p>
                {#if step.output}<pre class="mt-1.5 m-0 whitespace-pre-wrap break-all text-muted-foreground">{step.output}</pre>{/if}
              </section>
            {/each}
          </div>
        {/if}

        <div class="min-h-0 flex-1 overflow-y-auto font-mono text-[0.72rem]">
          {#each terminalHistory as entry, i (`${entry.command}-${i}`)}
            <div class="px-1 py-1.5">
              <div class="text-foreground">$ {entry.command}</div>
              {#if entry.output}
                <pre class="m-0 mt-0.5 whitespace-pre-wrap break-all {entry.error ? 'text-error' : 'text-muted-foreground'}">{entry.output}</pre>
              {/if}
            </div>
          {/each}
          {#if commandRunning}
            <div class="px-1 py-1.5 text-muted-foreground">Running…</div>
          {/if}
          {#if !executingSteps.length && !terminalHistory.length && !commandRunning}
            <div class="flex flex-col items-center justify-center gap-2 px-2 py-10 text-center text-muted-foreground">
              <Terminal class="size-6 opacity-50" />
              <p class="m-0 text-sm font-sans">Run commands in the workspace. Agent commands will also appear here.</p>
            </div>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-muted-foreground">$</span>
          <input
            type="text"
            class="aui-input flex-1 font-mono text-xs"
            bind:value={commandInput}
            onkeydown={handleTerminalKeydown}
            placeholder="command…"
            disabled={commandRunning}
          />
          <button type="button" class="aui-btn aui-btn-primary h-9 px-3 text-xs" onclick={runTerminalCommand} disabled={commandRunning || !commandInput.trim()}>
            Run
          </button>
        </div>
      </div>
    {/if}
  </div>
</aside>

<style>
  .change-kind {
    border-radius: 999px;
    background: var(--muted);
    color: var(--muted-foreground);
    padding: 0.1rem 0.4rem;
    font-size: 0.6rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .change-kind.created { color: var(--success); background: var(--success-bg); }
  .change-kind.modified { color: var(--foreground); }
  .change-kind.deleted { color: var(--error); background: var(--error-bg); }
</style>
