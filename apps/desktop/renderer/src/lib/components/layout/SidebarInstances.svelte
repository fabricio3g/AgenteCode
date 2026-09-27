<svelte:options runes={true} />

<!--
  The sidebar's "Running" list: local models that are loaded right now, with
  their state and port. Only there while something runs; a row opens
  Models → Running.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Wifi } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { instancesStore } from '$lib/stores/instances.svelte';

  onMount(() => void instancesStore.watch());

  function open() {
    appStore.modelManagerOpenSection = 'loaded';
    appStore.modelManagerOpen = true;
  }

  const tone = (state: string) => (state === 'error' ? 'error' : state === 'ready' || state === 'model_ready' ? 'ready' : 'busy');
</script>

{#if instancesStore.running.length}
  <div class="running">
    <p class="label">{$t('instances.sidebarTitle')}</p>
    {#each instancesStore.running as instance (instance.id)}
      <button type="button" class="row" onclick={open} title={instance.model_path}>
        <span class="dot {tone(instance.state)}" aria-hidden="true"></span>
        <span class="name">{instance.model_id.replace(/\.gguf$/i, '')}</span>
        {#if instance.shared}<Wifi class="size-3 shrink-0 opacity-60" aria-label={$t('instances.shared')} />{/if}
        {#if instancesStore.inChat(instance)}<span class="tag">{$t('instances.inChatShort')}</span>{:else if instance.port}<span class="port">:{instance.port}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .running {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 0.35rem;
  }

  .label {
    margin: 0;
    padding: 0.35rem 0.625rem 0.2rem;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, var(--muted-foreground));
  }

  .row {
    display: flex;
    width: 100%;
    min-width: 0;
    height: 1.9rem;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.625rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--sidebar-foreground, var(--foreground));
    font-size: 13px;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .row:hover {
    background: var(--sidebar-accent, var(--muted));
  }

  .dot {
    width: 0.45rem;
    height: 0.45rem;
    flex-shrink: 0;
    border-radius: 50%;
  }

  .dot.ready { background: var(--success, #22a06b); }
  .dot.busy { background: var(--warning, #d4a017); animation: pulse 1.2s ease-in-out infinite; }
  .dot.error { background: var(--error); }

  @keyframes pulse { 50% { opacity: 0.35; } }

  .name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .port,
  .tag {
    flex-shrink: 0;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }

  .tag {
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--accent-green-bg);
    color: var(--accent-green-text);
    font-weight: 500;
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.busy { animation: none; }
  }
</style>
