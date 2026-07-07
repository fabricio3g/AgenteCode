<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, AlertCircle, Bot, CheckCircle2, ChevronDown, Code2, FileCode2, Files, GitCompare, Shield, Terminal } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { detectProviderStatus, listCodeAgentProviders } from '$lib/services/agent-provider';
  import { isTauri, invoke } from '$lib/services/tauri';
  import type { AgentStep, CodeAgentFileChangeKind, CodeAgentProvider, CodeAgentProviderId, CodeAgentProviderStatus, CodeAgentRuntimeMode } from '$lib/types/chat';

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

  function stepText(step: AgentStep) {
    const detail = String(step.detail || '').replace(/\s+/g, ' ').trim();
    return detail ? `${step.label}: ${detail}` : step.label;
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

<aside class="code-drawer" aria-label="Code workspace">
  <header class="code-header">
    <div class="min-w-0 flex-1">
      <div class="header-title">Code workspace</div>
      <div class="header-subtitle">
        {currentChat?.title || 'New code'}{#if runningStep} · {runningStep.label}{/if}
      </div>
    </div>

    <button type="button" class="runtime-toggle" class:supervised={runtimeMode === 'supervised'} onclick={toggleRuntimeMode} title={runtimeMode === 'supervised' ? 'Supervised mode' : 'Full access'}>
      <Shield class="h-3 w-3" />
      <span>{runtimeMode === 'supervised' ? 'Sup' : 'Full'}</span>
    </button>

    <div class="provider-picker">
      <button
        type="button"
        class="provider-trigger"
        class:open={providerMenuOpen}
        onclick={() => (providerMenuOpen = !providerMenuOpen)}
        aria-haspopup="listbox"
        aria-expanded={providerMenuOpen}
      >
        <Bot class="h-3.5 w-3.5" />
        <span>{activeProvider.label}</span>
        <ChevronDown class={`h-3 w-3 transition-transform ${providerMenuOpen ? 'rotate-180' : ''}`} />
      </button>

      {#if providerMenuOpen}
        <div class="provider-menu" role="listbox">
          {#each providers as provider (provider.id)}
            {@const StatusIcon = statusIcon(provider.status)}
            <button
              type="button"
              class="provider-row"
              class:selected={activeProviderId === provider.id}
              class:disabled={provider.status !== 'ready'}
              onclick={() => selectProvider(provider.id)}
              role="option"
              aria-selected={activeProviderId === provider.id}
            >
              <span class="provider-icon"><Bot class="h-3.5 w-3.5" /></span>
              <span class="provider-copy">
                <span class="provider-name">{provider.label}</span>
                <span class="provider-detail">{provider.driver} · {provider.detail}</span>
              </span>
              <span class={`status-pill ${provider.status}`}>
                <StatusIcon class="h-3 w-3" />
                {statusLabel(provider.status)}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </header>

  <div class="code-tabs" role="tablist" aria-label="Code workspace panels">
    <button type="button" class="code-tab" class:active={activeTab === 'activity'} onclick={() => (activeTab = 'activity')}><Activity class="h-3.5 w-3.5" />Activity</button>
    <button type="button" class="code-tab" class:active={activeTab === 'diff'} onclick={() => (activeTab = 'diff')}><GitCompare class="h-3.5 w-3.5" />Diff</button>
    <button type="button" class="code-tab" class:active={activeTab === 'files'} onclick={() => (activeTab = 'files')}><Files class="h-3.5 w-3.5" />Files</button>
    <button type="button" class="code-tab" class:active={activeTab === 'terminal'} onclick={() => (activeTab = 'terminal')}><Terminal class="h-3.5 w-3.5" />Terminal</button>
  </div>

  <div class="code-body">
    {#if activeTab === 'activity'}
      {#if steps.length}
        <div class="timeline">
          {#each steps as step (step.id)}
            <article class="timeline-step" class:running={step.status === 'running'} class:error={step.status === 'error'}>
              <span class="step-dot"></span>
              <div class="step-content">
                <p>{stepText(step)}</p>
                {#if step.output}
                  <pre>{step.output}</pre>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <Bot class="h-6 w-6" />
          <p>Code agent activity will appear here.</p>
        </div>
      {/if}
    {:else if activeTab === 'diff'}
      {#if fileChanges.length}
        <div class="file-change-list">
          {#each fileChanges as change (`${change.kind}:${change.path}`)}
            {@const expanded = expandedDiffFile === change.path}
            {@const fileContent = getFileContent(change.path)}
            <section class="diff-block" class:expanded>
              <button type="button" class="diff-row" onclick={() => toggleDiffFile(change.path)} disabled={!fileContent}>
                <span class={`change-kind ${change.kind}`}>{changeLabel(change.kind)}</span>
                <span class="change-path">{change.path}</span>
                {#if fileContent}
                  <ChevronDown class={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                {/if}
              </button>
              {#if expanded && fileContent}
                <pre class="diff-content">{fileContent.slice(0, 6000)}{fileContent.length > 6000 ? '\n\n\u2026 (truncated)' : ''}</pre>
              {/if}
            </section>
          {/each}
        </div>
      {:else}
        <section class="mini-card">
          <div class="mini-card-title"><GitCompare class="h-3.5 w-3.5" />Diff tracking</div>
          <p>Changed files and turn diffs will use this panel. The built-in Chatea agent now reports created, modified, and deleted paths; external providers will feed the same view.</p>
        </section>
      {/if}
    {:else if activeTab === 'files'}
      {#if changedFilePaths.length}
        <div class="file-list">
          {#each changedFilePaths as file}
            {@const change = fileChanges.find((entry) => entry.path === file)}
            <button type="button" class="file-row" class:readonly={!artifactHasFile(file)} disabled={!artifactHasFile(file)} onclick={() => (appStore.sandboxOpen = true)}>
              <FileCode2 class="h-3.5 w-3.5" />
              <span>{file}</span>
              {#if change}
                <span class={`file-kind ${change.kind}`}>{changeLabel(change.kind)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <Files class="h-6 w-6" />
          <p>Files created or opened by the code agent will appear here.</p>
        </div>
      {/if}
    {:else if activeTab === 'terminal'}
      <div class="terminal-pane">
        {#if executingSteps.length}
          <div class="panel-stack">
            {#each executingSteps as step (step.id)}
              <section class="mini-card mono-card">
                <div class="mini-card-title"><Terminal class="h-3.5 w-3.5" />{step.label}</div>
                <p>{step.detail || 'Command'}</p>
                {#if step.output}<pre>{step.output}</pre>{/if}
              </section>
            {/each}
          </div>
        {/if}

        <div class="terminal-history">
          {#each terminalHistory as entry (`${entry.command}-${terminalHistory.length}`)}
            <div class="term-entry">
              <div class="term-prompt">$ {entry.command}</div>
              {#if entry.output}
                <pre class="term-output" class:term-error={entry.error}>{entry.output}</pre>
              {/if}
            </div>
          {/each}
          {#if commandRunning}
            <div class="term-entry">
              <div class="term-prompt running">Running…</div>
            </div>
          {/if}
          {#if !executingSteps.length && !terminalHistory.length && !commandRunning}
            <div class="empty-state">
              <Terminal class="h-6 w-6" />
              <p>Run commands in the workspace. Agent commands will also appear here.</p>
            </div>
          {/if}
        </div>

        <div class="terminal-input-row">
          <span class="term-prompt-symbol">$</span>
          <input
            type="text"
            class="terminal-input"
            bind:value={commandInput}
            onkeydown={handleTerminalKeydown}
            placeholder="command…"
            disabled={commandRunning}
          />
          <button type="button" class="term-run-btn" onclick={runTerminalCommand} disabled={commandRunning || !commandInput.trim()}>
            Run
          </button>
        </div>
      </div>
    {/if}
  </div>
</aside>

<style>
  .code-drawer {
    display: flex;
    width: 100%;
    min-width: 0;
    max-width: none;
    height: 100%;
    flex: 0 0 auto;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }

  .code-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0.42rem 0.55rem;
  }

  .header-title {
    color: var(--text);
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .header-subtitle {
    margin-top: 0.06rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.61rem;
  }

  .provider-picker {
    position: relative;
    flex: 0 0 auto;
  }

  .provider-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.55rem;
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-hover) 76%, transparent);
    color: var(--text);
    padding: 0 0.42rem;
    font-size: 0.64rem;
    font-weight: 660;
  }

  .provider-trigger:hover,
  .provider-trigger.open {
    background: color-mix(in srgb, var(--surface-hover) 92%, var(--primary) 8%);
  }

  .provider-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    z-index: 80;
    width: min(24rem, 46vw);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-overlay);
    box-shadow: var(--shadow-xl);
    padding: 0.25rem;
  }

  .provider-row {
    display: grid;
    width: 100%;
    grid-template-columns: 1.35rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    padding: 0.34rem;
    text-align: left;
  }

  .provider-row:not(.disabled):hover,
  .provider-row.selected {
    background: var(--surface-hover);
    border-color: var(--border);
  }

  .provider-row.disabled {
    cursor: default;
  }

  .provider-icon {
    display: inline-flex;
    height: 1.2rem;
    width: 1.2rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 9%, var(--surface-hover));
    color: var(--text);
  }

  .provider-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.08rem;
  }

  .provider-name {
    color: var(--text);
    font-size: 0.7rem;
    font-weight: 680;
  }

  .provider-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.6rem;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-muted);
    padding: 0.16rem 0.34rem;
    font-size: 0.58rem;
    font-weight: 720;
    white-space: nowrap;
  }

  .status-pill.ready {
    color: var(--success, #16a34a);
  }

  .status-pill.soon {
    color: var(--primary);
  }

  .code-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.22rem;
    padding: 0.35rem 0.45rem 0.25rem;
  }

  .code-tab {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    height: 1.55rem;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
    color: var(--text-muted);
    font-size: 0.62rem;
    font-weight: 680;
  }

  .code-tab:hover,
  .code-tab.active {
    background: color-mix(in srgb, var(--primary) 9%, var(--surface-hover));
    color: var(--text);
  }

  .code-body {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 0.42rem 0.5rem 0.65rem;
  }

  .timeline,
  .panel-stack,
  .file-list,
  .file-change-list {
    display: flex;
    flex-direction: column;
    gap: 0.38rem;
  }

  .diff-block {
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-hover) 42%, transparent);
    overflow: hidden;
  }

  .diff-block.expanded {
    border-color: var(--border);
  }

  .diff-row {
    display: grid;
    width: 100%;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
    border: 0;
    background: transparent;
    padding: 0.5rem;
    text-align: left;
    cursor: default;
  }

  .diff-row:not(:disabled):hover {
    background: color-mix(in srgb, var(--surface-hover) 58%, transparent);
  }

  .diff-row:disabled {
    opacity: 0.7;
  }

  .diff-content {
    margin: 0;
    padding: 0.4rem 0.55rem 0.55rem;
    border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    overflow: auto;
    max-height: 18rem;
    line-height: 1.45;
  }

  .change-kind,
  .file-kind {
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 0.58rem;
    font-weight: 760;
    letter-spacing: 0.01em;
    line-height: 1;
    padding: 0.25rem 0.38rem;
    text-transform: uppercase;
  }

  .change-kind.created,
  .file-kind.created {
    color: var(--success, #16a34a);
  }

  .change-kind.modified,
  .file-kind.modified {
    color: var(--primary);
  }

  .change-kind.deleted,
  .file-kind.deleted {
    color: var(--error);
  }

  .change-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .timeline-step {
    display: grid;
    grid-template-columns: 0.7rem 1fr;
    gap: 0.5rem;
    align-items: start;
  }

  .step-dot {
    width: 0.48rem;
    height: 0.48rem;
    margin-top: 0.42rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 45%, transparent);
  }

  .timeline-step.running .step-dot {
    background: var(--primary);
    box-shadow: 0 0 0 0.25rem color-mix(in srgb, var(--primary) 12%, transparent);
  }

  .timeline-step.error .step-dot {
    background: var(--error);
  }

  .step-content p,
  .mini-card p,
  .empty-state p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.48;
    overflow-wrap: anywhere;
  }

  .step-content pre,
  .mini-card pre {
    margin: 0.45rem 0 0;
    max-height: 12rem;
    overflow: auto;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .mini-card {
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface-hover) 46%, transparent);
    padding: 0.7rem;
  }

  .mini-card-title {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.35rem;
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 720;
  }

  .mono-card p {
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    padding: 0.45rem 0.5rem;
    text-align: left;
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .file-row span:nth-child(2) {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-row:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: var(--border);
    color: var(--text);
  }

  .file-row.readonly {
    cursor: default;
    opacity: 0.78;
  }

  .empty-state {
    display: flex;
    min-height: 6rem;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: var(--radius-xl);
    color: var(--text-muted);
    padding: 1rem;
    text-align: center;
  }

  .runtime-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.55rem;
    border: 1px solid color-mix(in srgb, var(--success, #16a34a) 42%, var(--border) 58%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--success, #16a34a) 8%, transparent);
    color: var(--success, #16a34a);
    padding: 0 0.42rem;
    font-size: 0.58rem;
    font-weight: 760;
    cursor: pointer;
    white-space: nowrap;
  }

  .runtime-toggle.supervised {
    border-color: color-mix(in srgb, var(--primary) 42%, var(--border) 58%);
    background: color-mix(in srgb, var(--primary) 8%, transparent);
    color: var(--primary);
  }

  .terminal-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    gap: 0.5rem;
  }

  .terminal-history {
    min-height: 0;
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .terminal-input-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-hover) 64%, transparent);
    padding: 0.3rem 0.45rem;
  }

  .term-prompt-symbol {
    color: var(--success, #16a34a);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 700;
    padding-left: 0.15rem;
  }

  .terminal-input {
    min-width: 0;
    flex: 1;
    border: 0;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    outline: none;
  }

  .terminal-input::placeholder {
    color: var(--text-muted);
  }

  .term-run-btn {
    height: 1.5rem;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 14%, transparent);
    color: var(--primary);
    padding: 0 0.5rem;
    font-size: 0.62rem;
    font-weight: 720;
    cursor: pointer;
    white-space: nowrap;
  }

  .term-run-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .term-entry {
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-hover) 32%, transparent);
    padding: 0.4rem 0.5rem;
  }

  .term-prompt {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text);
  }

  .term-prompt.running {
    color: var(--text-muted);
    font-style: italic;
  }

  .term-output {
    margin: 0.3rem 0 0;
    max-height: 10rem;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .term-output.term-error {
    color: var(--error);
  }
</style>
