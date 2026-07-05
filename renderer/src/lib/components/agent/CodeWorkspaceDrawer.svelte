<svelte:options runes={true} />

<script lang="ts">
  import { Activity, AlertCircle, Bot, CheckCircle2, ChevronDown, Code2, FileCode2, Files, GitCompare, Terminal } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { AgentStep, CodeAgentFileChangeKind, CodeAgentProvider, CodeAgentProviderId, CodeAgentProviderStatus } from '$lib/types/chat';

  type DrawerTab = 'activity' | 'diff' | 'files' | 'terminal';

  const providers: CodeAgentProvider[] = [
    { id: 'builtin', label: 'Chatea Agent', driver: 'Built-in', detail: 'Current local agent', status: 'ready' },
    { id: 'codex', label: 'Codex', driver: 'CLI', detail: 'OpenAI Codex CLI', status: 'missing' },
    { id: 'claude', label: 'Claude Code', driver: 'CLI', detail: 'Anthropic Claude Code', status: 'login' },
    { id: 'cursor', label: 'Cursor Agent', driver: 'CLI/ACP', detail: 'Cursor coding agent', status: 'disabled' },
    { id: 'opencode', label: 'OpenCode', driver: 'CLI/server', detail: 'OpenCode runtime', status: 'missing' },
    { id: 'pi', label: 'Pi Agent', driver: 'Agent', detail: 'Pi coding agent', status: 'soon' }
  ];

  let activeTab = $state<DrawerTab>('activity');
  let providerMenuOpen = $state(false);

  const currentChat = $derived(appStore.currentChat);
  const activeProviderId = $derived<CodeAgentProviderId>(currentChat?.codeAgent?.providerId || 'builtin');
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

  function selectProvider(providerId: CodeAgentProviderId) {
    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider || provider.status !== 'ready') return;
    appStore.setCodeAgentProvider(providerId);
    providerMenuOpen = false;
  }
</script>

<aside class="code-drawer" aria-label="Code workspace">
  <header class="code-header">
    <div class="min-w-0 flex-1">
      <div class="header-title">Code workspace</div>
      <div class="header-subtitle">
        {currentChat?.title || 'New code'}{#if runningStep} · {runningStep.label}{/if}
      </div>
    </div>

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
            <section class="file-change-row">
              <span class={`change-kind ${change.kind}`}>{changeLabel(change.kind)}</span>
              <span class="change-path">{change.path}</span>
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
      {:else}
        <div class="empty-state">
          <Terminal class="h-6 w-6" />
          <p>Commands and terminal output will appear here.</p>
        </div>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .code-drawer {
    display: flex;
    width: min(25rem, 31vw);
    min-width: 20rem;
    max-width: 28rem;
    height: 100%;
    flex: 0 0 auto;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 22px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }

  .code-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    padding: 0.65rem 0.7rem 0.55rem;
  }

  .header-title {
    color: var(--text);
    font-size: 0.78rem;
    font-weight: 720;
    line-height: 1.2;
  }

  .header-subtitle {
    margin-top: 0.12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.66rem;
  }

  .provider-picker {
    position: relative;
    flex: 0 0 auto;
  }

  .provider-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: 1.85rem;
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-hover) 76%, transparent);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.72rem;
    font-weight: 680;
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
    width: 22rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-xl);
    padding: 0.35rem;
  }

  .provider-row {
    display: grid;
    width: 100%;
    grid-template-columns: 1.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    padding: 0.45rem;
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
    height: 1.35rem;
    width: 1.35rem;
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
    font-size: 0.78rem;
    font-weight: 700;
  }

  .provider-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.66rem;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-muted);
    padding: 0.22rem 0.42rem;
    font-size: 0.62rem;
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
    gap: 0.3rem;
    padding: 0.55rem 0.65rem 0.35rem;
  }

  .code-tab {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 0.24rem;
    height: 1.8rem;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 720;
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
    padding: 0.55rem 0.7rem 0.85rem;
  }

  .timeline,
  .panel-stack,
  .file-list,
  .file-change-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .file-change-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.45rem;
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-hover) 42%, transparent);
    padding: 0.5rem;
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
    min-height: 12rem;
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
</style>
