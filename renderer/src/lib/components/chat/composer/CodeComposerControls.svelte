<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Bot, ChevronDown, Plus, Shield } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { detectCodeAgentInstanceStatus, listCodeAgentProviders } from '$lib/services/agent-provider';
  import type { CodeAgentProvider, CodeAgentProviderStatus, CodeAgentRuntimeMode } from '$lib/types/chat';

  let providerTriggerEl = $state<HTMLButtonElement | undefined>();
  let providerMenuEl = $state<HTMLDivElement | undefined>();
  let runtimeTriggerEl = $state<HTMLButtonElement | undefined>();
  let runtimeMenuEl = $state<HTMLDivElement | undefined>();
  let providerOpen = $state(false);
  let runtimeOpen = $state(false);
  let providers = $state<CodeAgentProvider[]>(listCodeAgentProviders().filter((p) => p.driver !== 'chatea'));

  const activeInstanceId = $derived(appStore.currentChat?.codeAgent?.instanceId || 'chatea-agent');
  const activeProvider = $derived(providers.find((provider) => provider.id === activeInstanceId) || providers[0]);
  const runtimeMode = $derived<CodeAgentRuntimeMode>(appStore.currentChat?.codeAgent?.runtimeMode || 'full');

  function statusLabel(status: CodeAgentProviderStatus) {
    switch (status) {
      case 'ready': return 'Ready';
      case 'missing': return 'Not installed';
      case 'login': return 'Login required';
      case 'soon': return 'Coming soon';
      case 'disabled': return 'Disabled';
    }
  }

  function selectProvider(provider: CodeAgentProvider) {
    if (provider.status !== 'ready') return;
    appStore.setCodeAgentProvider(provider.id);
    providerOpen = false;
  }

  function selectRuntime(mode: CodeAgentRuntimeMode) {
    appStore.setCodeAgentRuntimeMode(mode);
    runtimeOpen = false;
  }

  onMount(() => {
    for (const provider of providers) {
      detectCodeAgentInstanceStatus(provider.id).then((status) => {
        providers = providers.map((entry) => entry.id === provider.id ? { ...entry, status } : entry);
      });
    }
  });

  $effect(() => {
    if (!providerOpen && !runtimeOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (providerOpen && providerTriggerEl && providerMenuEl && !providerTriggerEl.contains(target) && !providerMenuEl.contains(target)) providerOpen = false;
      if (runtimeOpen && runtimeTriggerEl && runtimeMenuEl && !runtimeTriggerEl.contains(target) && !runtimeMenuEl.contains(target)) runtimeOpen = false;
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        providerOpen = false;
        runtimeOpen = false;
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<div class="code-controls inline-flex items-center gap-1.5">
  <button type="button" class="code-icon-btn" aria-label="Add context or action" title="Add context or action">
    <Plus class="h-3.5 w-3.5" />
  </button>

  <div class="relative inline-flex">
    <button
      bind:this={providerTriggerEl}
      type="button"
      class="code-pill"
      class:is-open={providerOpen}
      onclick={() => { providerOpen = !providerOpen; runtimeOpen = false; }}
      aria-haspopup="listbox"
      aria-expanded={providerOpen}
    >
      <Bot class="h-3.5 w-3.5" />
      <span>{activeProvider?.label || 'Flaxeo Agent'}</span>
      <ChevronDown class={`h-3 w-3 transition-transform ${providerOpen ? 'rotate-180' : ''}`} />
    </button>

    {#if providerOpen}
      <div bind:this={providerMenuEl} class="code-menu min-w-[230px]" role="listbox">
        {#each providers as provider (provider.id)}
          <button
            type="button"
            class="code-menu-row"
            class:selected={provider.id === activeInstanceId}
            class:disabled={provider.status !== 'ready'}
            onclick={() => selectProvider(provider)}
            role="option"
            aria-selected={provider.id === activeInstanceId}
          >
            <span class="provider-dot" style={`background: ${provider.accentColor || 'var(--primary)'};`}></span>
            <span class="provider-copy">
              <span class="provider-name">{provider.label}</span>
              <span class="provider-detail">{provider.driver} · {provider.detail}</span>
            </span>
            <span class={`provider-status ${provider.status}`}>{statusLabel(provider.status)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="relative inline-flex">
    <button
      bind:this={runtimeTriggerEl}
      type="button"
      class="code-pill runtime"
      class:is-open={runtimeOpen}
      onclick={() => { runtimeOpen = !runtimeOpen; providerOpen = false; }}
      aria-haspopup="listbox"
      aria-expanded={runtimeOpen}
    >
      <Shield class="h-3.5 w-3.5" />
      <span>{runtimeMode === 'full' ? 'Full access' : 'Supervised'}</span>
      <ChevronDown class={`h-3 w-3 transition-transform ${runtimeOpen ? 'rotate-180' : ''}`} />
    </button>

    {#if runtimeOpen}
      <div bind:this={runtimeMenuEl} class="code-menu min-w-[180px]" role="listbox">
        <button type="button" class="code-menu-row compact" class:selected={runtimeMode === 'full'} onclick={() => selectRuntime('full')} role="option" aria-selected={runtimeMode === 'full'}>
          <span class="provider-name">Full access</span>
          <span class="provider-status ready">No approvals</span>
        </button>
        <button type="button" class="code-menu-row compact" class:selected={runtimeMode === 'supervised'} onclick={() => selectRuntime('supervised')} role="option" aria-selected={runtimeMode === 'supervised'}>
          <span class="provider-name">Supervised</span>
          <span class="provider-status login">Ask first</span>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .code-icon-btn,
  .code-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    background: color-mix(in srgb, var(--surface-hover) 58%, transparent);
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 720;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }

  .code-icon-btn {
    width: 2rem;
    justify-content: center;
  }

  .code-pill {
    padding: 0 0.58rem;
  }

  .code-icon-btn:hover,
  .code-pill:hover,
  .code-pill.is-open {
    border-color: var(--border-hover);
    background: var(--surface-hover);
    color: var(--text);
  }

  .code-pill.runtime {
    color: var(--text-muted);
  }

  .code-menu {
    position: absolute;
    bottom: calc(100% + 0.45rem);
    left: 0;
    z-index: 220;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.8rem;
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    padding: 0.35rem;
  }

  .code-menu-row {
    display: grid;
    width: 100%;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
    border: 0;
    border-radius: 0.55rem;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.48rem 0.55rem;
    text-align: left;
  }

  .code-menu-row.compact {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .code-menu-row:not(.disabled):hover,
  .code-menu-row.selected {
    background: var(--surface-hover);
    color: var(--text);
  }

  .code-menu-row.disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }

  .provider-dot {
    width: 0.58rem;
    height: 0.58rem;
    border-radius: 999px;
    box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 8%, transparent);
  }

  .provider-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }

  .provider-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    font-weight: 760;
  }

  .provider-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.68rem;
  }

  .provider-status {
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-muted);
    padding: 0.16rem 0.38rem;
    font-size: 0.62rem;
    font-weight: 760;
    white-space: nowrap;
  }

  .provider-status.ready { color: var(--success, #16a34a); }
  .provider-status.login { color: var(--warning, #d97706); }
  .provider-status.missing,
  .provider-status.disabled { color: var(--error); }
  .provider-status.soon { color: var(--primary); }
</style>
